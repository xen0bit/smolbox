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


def _graph_exceeds_protobuf_limit(model: onnx.ModelProto) -> bool:
    """Whether this graph must use external data.

    `ByteSize()` does not merely report a large number past 2 GiB — it raises
    EncodeError, because protobuf cannot serialize the message at all. So the
    exception *is* the signal, and catching it is the check rather than a
    fallback. 1B hits this; 350M does not.
    """
    try:
        return model.ByteSize() >= EXTERNAL_DATA_THRESHOLD
    except Exception:
        return True


def _save(model: onnx.ModelProto, path: Path) -> int:
    """Save, spilling weights to a sidecar only when the graph needs it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if _graph_exceeds_protobuf_limit(model):
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
    """Whether the fp16 result will still exceed protobuf's inline limit.

    fp16 halves the weights, so a graph only needs a sidecar if it was more than
    twice the threshold to begin with. Checked against the source files on disk
    because the converted graph does not exist yet.
    """
    total = src.stat().st_size + sum(f.stat().st_size for f in src.parent.glob(f"{src.name}_data"))
    return total / 2 >= EXTERNAL_DATA_THRESHOLD


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
