"""Reduce the exported graph and assemble a transformers.js model directory.

Split out of convert_antares.py because the remap is the interesting half and
this is the mechanical half: an fp16 pass and a directory layout that
web/src/agent/models.ts can load without knowing anything special happened.

Two things here are load-bearing rather than incidental:

- **fp16 is the only reduced variant, and it comes from onnxruntime's converter
  rather than onnxconverter_common's.** Both halves of that sentence were forced
  by measurement, not preference — see `_to_fp16` and PLAN §11.10. Antares will
  not survive int4, and the obvious fp16 converter will not produce a loadable
  graph for this architecture.
- The **`transformers.js_config` block**. transformers.js reads
  `use_external_data_format` to decide whether to fetch a `.onnx_data` sidecar,
  and `kv_cache_dtype` to allocate the KV cache at the right precision for f16
  variants. Omitting either produces a load failure that points nowhere near
  the cause.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import onnx

# ONNX protobuf cannot address more than 2 GiB inline, so anything at or near it
# needs its weights in a sidecar. Kept well under the hard limit: the graph
# itself grows a little when quantized nodes are added.
EXTERNAL_DATA_THRESHOLD = 1_900_000_000

# The ceiling that actually matters, and it is not protobuf's.
#
# A browser fails on an inline checkpoint long before 2 GiB, for two stacked
# reasons: transformers.js reads a weight file into ONE Uint8Array before
# onnxruntime sees any of it, and onnxruntime then builds the session inside the
# wasm heap. Measured on this machine (PLAN §10.18), all single-file:
#
#     786 MB  (Qwen2.5 0.5B q4)      loads and runs
#   1.43 GB  (Qwen3 1.7B q4f16)      Can't create a session, std::bad_alloc
#   1.74 GB  (Qwen3 1.7B q8)         Can't create a session, std::bad_alloc
#   1.82 GB  (Antares 350M fp32)     Can't create a session, std::bad_alloc
#   2.15 GB  (Qwen3 1.7B q4)         RangeError, out of readResponse
#
# The same 1.82 GB graph re-saved with its weights in a sidecar loads in 8.0 s
# and generates. So sharding is not a protobuf workaround here — it is what
# makes a mid-size checkpoint loadable in a browser at all.
#
# Set between the largest inline file measured to work and the smallest measured
# to fail. Sharding a graph that would have fitted costs one extra HTTP request
# and nothing else, so erring low is close to free; erring high produces a
# multi-gigabyte download that ends in std::bad_alloc.
BROWSER_INLINE_CEILING = 1_000_000_000

TOKENIZER_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
    "generation_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
)


def log(msg: str) -> None:
    print(f"  {msg}", file=sys.stderr, flush=True)


def _human(n: int) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.1f} MB"


def _needs_sidecar(model: onnx.ModelProto) -> bool:
    """Whether this graph should keep its weights in a sidecar.

    Two independent reasons, and the second is the one that bites first:

    - protobuf cannot serialize past 2 GiB at all. `ByteSize()` does not merely
      report a large number there — it raises EncodeError, so the exception *is*
      the signal and catching it is the check rather than a fallback. 1B hits
      this; 350M does not.
    - a browser cannot load an inline graph anywhere near that large, which is
      what BROWSER_INLINE_CEILING records.
    """
    try:
        return model.ByteSize() >= min(EXTERNAL_DATA_THRESHOLD, BROWSER_INLINE_CEILING)
    except Exception:
        return True


def _save(model: onnx.ModelProto, path: Path) -> int:
    """Save, spilling weights to a sidecar when the graph needs it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if _needs_sidecar(model):
        data_name = f"{path.name}_data"
        onnx.save_model(
            model,
            str(path),
            save_as_external_data=True,
            all_tensors_to_one_file=True,
            location=data_name,
            size_threshold=1024,
            convert_attribute=False,
        )
        external = True
    else:
        onnx.save_model(model, str(path))
        external = False
    on_disk = path.stat().st_size + (
        (path.parent / f"{path.name}_data").stat().st_size
        if (path.parent / f"{path.name}_data").exists()
        else 0
    )
    log(f"{path.name}: {_human(on_disk)}{' (external data)' if external else ''}")
    return on_disk


def _to_fp16(src: Path, dst: Path) -> int:
    """Convert to fp16 using onnxruntime's converter, not onnxconverter_common's.

    This is not a preference. `onnxconverter_common.float16` cannot produce a
    loadable graph for this architecture: Granite's RMSNorm already contains
    explicit fp32 Casts, and the converter double-handles them into a graph ORT
    rejects with either "Type parameter (T) of Optype (Add) bound to different
    types" (shape inference off) or a Cast whose output type contradicts its
    consumer (shape inference on). Both were measured (PLAN §11.10).

    onnxruntime's own `OnnxModel.convert_float_to_float16` uses *symbolic* shape
    inference, which resolves the existing Casts correctly, and it streams large
    graphs rather than hitting protobuf's 2 GiB ceiling — which the 1B model
    needs. Measured result on 350M: logit correlation 0.999514 against the fp32
    reference, versus 0.816 for the best int4 build.
    """
    from onnxruntime.transformers.onnx_model import OnnxModel

    model = OnnxModel(onnx.load(str(src)))
    model.convert_float_to_float16(keep_io_types=True, use_symbolic_shape_infer=True)
    dst.parent.mkdir(parents=True, exist_ok=True)
    model.save_model_to_file(str(dst), use_external_data_format=_needs_external(src))
    _normalise_external_data_name(dst)

    sidecar = dst.parent / f"{dst.name}_data"
    on_disk = dst.stat().st_size + (sidecar.stat().st_size if sidecar.exists() else 0)
    log(f"{dst.name}: {_human(on_disk)}{' (external data)' if sidecar.exists() else ''}")
    return on_disk


def _normalise_external_data_name(path: Path) -> None:
    """Rename ORT's `X.onnx.data` sidecar to the `X.onnx_data` transformers.js reads.

    onnxruntime hardcodes `<name>.data` with no way to override it; optimum,
    onnx-community and transformers.js all use `<name>_data`. The name is
    recorded inside every external initializer, so renaming the file alone
    produces a graph that loads and then fails to find its weights — the
    references have to be rewritten too.
    """
    ort_sidecar = path.parent / f"{path.name}.data"
    if not ort_sidecar.exists():
        return
    wanted = f"{path.name}_data"
    ort_sidecar.replace(path.parent / wanted)

    # load_external_data=False keeps this a metadata-only edit: the multi-GB
    # sidecar is never read into memory, just re-pointed at.
    model = onnx.load(str(path), load_external_data=False)
    for initializer in model.graph.initializer:
        for entry in initializer.external_data:
            if entry.key == "location":
                entry.value = wanted
    onnx.save_model(model, str(path))


def _needs_external(src: Path) -> bool:
    """Whether the fp16 result should spill its weights to a sidecar.

    fp16 halves the weights, so the result is predicted from the source files on
    disk — the converted graph does not exist yet. Measured against
    BROWSER_INLINE_CEILING rather than protobuf's limit: the question is not
    "can this be serialized" but "can a browser load it", and the second wall is
    the lower one by more than a gigabyte.
    """
    total = src.stat().st_size + sum(f.stat().st_size for f in src.parent.glob(f"{src.name}_data"))
    return total / 2 >= BROWSER_INLINE_CEILING


def _reshard_inline(path: Path) -> bool:
    """Move an inline graph's weights into a sidecar, in place.

    The exporter emits whatever protobuf allows, which for a mid-size model is
    one 1–2 GB file that no browser can load (see BROWSER_INLINE_CEILING). This
    rewrites it into `model.onnx` + `model.onnx_data` without touching a weight
    value.

    Only ever reached in the safe range. Below the ceiling there is nothing to
    do; above 2 GiB the exporter already wrote a sidecar, because protobuf gave
    it no choice. So the round trip through memory that would be reckless on a
    >2 GiB graph — it cannot be serialized at all — never happens here.

    Returns whether it did anything.
    """
    sidecar = path.parent / f"{path.name}_data"
    if sidecar.exists() or path.stat().st_size < BROWSER_INLINE_CEILING:
        return False
    log(f"{path.name}: {_human(path.stat().st_size)} inline — moving weights to a sidecar")
    model = onnx.load(str(path))
    onnx.save_model(
        model,
        str(path),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=sidecar.name,
        size_threshold=1024,
        convert_attribute=False,
    )
    log(f"{path.name}: {_human(path.stat().st_size)} graph + {_human(sidecar.stat().st_size)} data")
    return True


def assemble(*, source: Path, granite: Path, onnx_raw: Path, out: Path) -> None:
    """Build the final transformers.js model directory.

    `source` is the original Antares checkpoint (authoritative for tokenizer and
    chat template), `granite` the remapped one (authoritative for config), and
    `onnx_raw` optimum's export directory.
    """
    # Wipe the graph directory rather than writing over it. A previous run's
    # variants are indistinguishable from this one's on disk, and a stale
    # model_q4f16.onnx that the current pipeline no longer produces will happily
    # be loaded by the page and blamed on this build.
    onnx_dir = out / "onnx"
    if onnx_dir.exists():
        shutil.rmtree(onnx_dir)
    out.mkdir(parents=True, exist_ok=True)
    onnx_dir.mkdir()

    exported = onnx_raw / "model.onnx"
    if not exported.exists():
        raise FileNotFoundError(f"expected {exported} from the exporter")

    variants: dict[str, Path] = {}

    # fp32 is kept, not discarded. It is the ground truth every other variant is
    # measured against (tools/verify_onnx.py), and without it a quantization
    # regression is indistinguishable from an export bug — which is exactly the
    # confusion this build hit the first time round.
    # Copied as files, not loaded and re-saved: a >2 GiB graph cannot round-trip
    # through protobuf in memory at all, and re-serialising a graph we do not
    # need to modify is pure risk.
    log("copying fp32 reference graph")
    fp32 = onnx_dir / "model.onnx"
    total = 0
    for src_file in sorted(onnx_raw.glob("model.onnx*")):
        shutil.copy2(src_file, onnx_dir / src_file.name)
        total += src_file.stat().st_size
    # The exporter shards only when protobuf forces it, which leaves 350M as one
    # 1.82 GB file — over the browser's ceiling by nearly a gigabyte, and the
    # reason fp32 was unloadable rather than merely large (PLAN §10.18). Doing
    # it here rather than asking optimum for it keeps the rule in one place and
    # applies it to any future model this pipeline exports.
    _reshard_inline(fp32)
    total = fp32.stat().st_size + sum(f.stat().st_size for f in onnx_dir.glob("model.onnx_data"))
    log(f"model.onnx: {_human(total)}"
        f"{' (external data)' if (onnx_dir / 'model.onnx_data').exists() else ''}")
    variants["fp32"] = fp32

    # fp16 is the shipping variant. Not a compromise between fp32 and int4 —
    # the only one of the three that is both loadable in a browser and faithful
    # enough to keep Antares following its own protocol (PLAN §11.10).
    log("converting fp16")
    fp16 = onnx_dir / "model_fp16.onnx"
    _to_fp16(fp32, fp16)
    variants["fp16"] = fp16

    # No int4 and no int8 variant, deliberately. Antares' RL-tuned weights are
    # quantization-hostile in a way the Granite instruct weights they came from
    # are not: this repo's quantizer scores 0.943 logit correlation on the base
    # model (better than onnx-community's own published q4 at 0.930) and 0.816
    # on Antares. Behaviourally that costs the protocol — 1B at q4 emits raw
    # JSON with hallucinated paths, or an empty <tool_call>, where the same
    # prompt at full precision produces a clean call. A dtype that looks like a
    # size win and silently breaks tool calling is worse than no dtype.

    # config.json comes from the remapped model (it is what the ONNX graph
    # actually implements), plus the block transformers.js needs to load it.
    config = json.loads((granite / "config.json").read_text())
    # Keyed by the file's real name, not by dtype: fp32 lives in `model.onnx`,
    # not `model_fp32.onnx`, and a key that names a file which does not exist
    # means transformers.js never fetches the sidecar it needs.
    config["transformers.js_config"] = {
        "use_external_data_format": {
            path.name: 1
            for path in variants.values()
            if (path.parent / f"{path.name}_data").exists()
        },
        "kv_cache_dtype": {"fp16": "float16"},
    }
    # Recorded so the provenance of these weights is legible from the artifact
    # alone, not just from the build log.
    config["_smolbox_conversion"] = {
        "source_repo": source.name,
        "remap": "granitemoehybrid -> granite (shared_mlp.input_linear split into gate/up)",
        "note": "See PLAN §11.3. Parity against the source checkpoint is enforced at build time.",
    }
    (out / "config.json").write_text(json.dumps(config, indent=2) + "\n")

    # Tokenizer and chat template from the ORIGINAL checkpoint, never the
    # exporter's copy: Antares ships a modified chat template (the <think>
    # prefill, PLAN §11.9) and the round trip through save_pretrained is not
    # guaranteed to preserve it byte for byte.
    copied = []
    for name in TOKENIZER_FILES:
        candidate = source / name
        if not candidate.exists():
            candidate = onnx_raw / name
        if candidate.exists():
            shutil.copy2(candidate, out / name)
            copied.append(name)
    log(f"copied {len(copied)} tokenizer/template files")

    template = out / "chat_template.jinja"
    if template.exists() and "<think>" not in template.read_text():
        raise RuntimeError(
            "chat_template.jinja lost its <think> prefill — the generation prompt would "
            "no longer match what Antares was trained to continue (PLAN §11.9)."
        )

    _inline_chat_template(out, template)


def _inline_chat_template(out: Path, template: Path) -> None:
    """Copy the standalone template into tokenizer_config.json as well.

    The file is kept — Python transformers prefers it, and it is the byte-exact
    artifact the check above guards. But it cannot be the only copy, because the
    runtime this build exists to serve does not read it: transformers.js'
    AutoTokenizer takes `chat_template` from tokenizer_config.json and nowhere
    else, and loads chat_template.jinja only through Processor, on the
    multimodal path.

    That asymmetry is why this was not caught at build time. Every check in this
    pipeline runs under Python transformers, which does read the file, so a
    build whose template the browser cannot see passes parity, passes
    verify_onnx.py, loads on the page — and then throws inside
    apply_chat_template on the first turn, with a stack that points at the
    tokenizer rather than at the conversion that produced it.

    Writing both keeps the two runtimes reading the same template, which is the
    only property that matters here.
    """
    if not template.exists():
        return

    config_path = out / "tokenizer_config.json"
    if not config_path.exists():
        raise RuntimeError(
            f"{config_path.name} is missing, so the chat template has nowhere to live that "
            "transformers.js will look — the build would load and then fail on its first turn."
        )

    text = template.read_text()
    config = json.loads(config_path.read_text())
    config["chat_template"] = text
    config_path.write_text(json.dumps(config, indent=2) + "\n")

    # Read back rather than trust the write: this is the one property the
    # browser depends on and the one nothing downstream of here re-checks.
    written = json.loads(config_path.read_text()).get("chat_template")
    if written != text:
        raise RuntimeError(f"chat_template did not survive the round trip into {config_path.name}")
    log(f"inlined chat_template into tokenizer_config.json ({len(text)} chars)")
