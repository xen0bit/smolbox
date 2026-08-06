"""Convert a gated Antares checkpoint to ONNX for transformers.js / WebGPU.

Run through `make antares-onnx`, never directly — the Makefile target owns the
uv invocation and the .env loading.

Why this file exists at all (PLAN §11.1.5): no ONNX build of Antares is
published anywhere, and transformers.js cannot load safetensors. Every other
model in web/src/agent/models.ts is a download; this one is a build.

The interesting part is the remap. Antares declares
`model_type: "granitemoehybrid"` and optimum refuses to export that type. But
the config is all-attention with zero experts (PLAN §11.1.2): a
`granitemoehybrid` with `layer_types` of 28x"attention" is a dense GQA
transformer wearing a hybrid's name, and `GraniteMoeHybridForCausalLM` differs
from the natively-exportable `GraniteForCausalLM` in exactly one respect — it
fuses gate and up projections into `shared_mlp.input_linear`, where Granite
keeps `mlp.gate_proj` and `mlp.up_proj` apart. Splitting that tensor turns an
unexportable model into an exportable one without touching a single weight
value.

That claim is not taken on faith. `check_parity` runs both models on a real
Antares prompt and fails the build if their logits disagree, because a silently
wrong remap is exactly the failure mode this conversion has to rule out — muP
scalars (embedding/attention/residual multipliers, logits scaling) and tied
embeddings are the sort of thing an exporter drops without saying so.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Keys carried from the granitemoehybrid config onto the granite one. Anything
# not listed is either mamba dead weight (PLAN §11.1.2) or a Granite default.
# The muP scalars are the load-bearing entries: drop one and the model still
# exports, still runs, and produces garbage.
CARRIED_CONFIG_KEYS = (
    "vocab_size",
    "hidden_size",
    "num_hidden_layers",
    "num_attention_heads",
    "num_key_value_heads",
    "hidden_act",
    "max_position_embeddings",
    "rms_norm_eps",
    "rope_theta",
    "tie_word_embeddings",
    "attention_bias",
    "attention_dropout",
    "embedding_multiplier",
    "residual_multiplier",
    "logits_scaling",
    "attention_multiplier",
    "bos_token_id",
    "eos_token_id",
    "pad_token_id",
)

# Copied verbatim into the output. The chat template is why: Antares ships a
# modified one whose only diff from stock Granite is the <think> prefill
# (PLAN §11.9), and losing it would silently change the model's behaviour.
TOKENIZER_FILES = (
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
    "generation_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
)

KNOWN_MODELS = {
    "antares-350m": "fdtn-ai/antares-350m",
    "antares-1b": "fdtn-ai/antares-1b",
}


def log(msg: str) -> None:
    print(f"  {msg}", file=sys.stderr, flush=True)


def step(msg: str) -> None:
    print(f"\n==> {msg}", file=sys.stderr, flush=True)


class ConversionError(RuntimeError):
    """A failure with an actionable message. Printed without a traceback."""


@dataclass(frozen=True)
class Paths:
    source: Path
    out: Path


def resolve_source(model_key: str, repo_id: str) -> Path:
    """Find the checkpoint locally, or download it.

    Local first, deliberately: `dist/models/<repo>` is where the download in
    PLAN §11.9 already put these, and re-pulling 3.7 GB to convert it again is
    the sort of thing that makes a build target unpleasant enough to avoid.
    """
    local = REPO_ROOT / "dist" / "models" / repo_id
    if (local / "model.safetensors").exists():
        log(f"using local checkpoint: {local}")
        return local

    import os

    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise ConversionError(
            f"{repo_id} is not in dist/models and HF_TOKEN is not set.\n"
            f"  These weights are gated: accept the terms at\n"
            f"      https://huggingface.co/{repo_id}\n"
            f"  then put a token with read access in .env:\n"
            f"      HF_TOKEN=hf_...\n"
            f"  (see .env.example)"
        )

    from huggingface_hub import snapshot_download
    from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError

    log(f"downloading {repo_id} (not found locally)")
    try:
        got = snapshot_download(
            repo_id=repo_id,
            local_dir=str(local),
            token=token,
            allow_patterns=["*.json", "*.jinja", "*.safetensors", "*.txt"],
        )
    except GatedRepoError as err:
        # Worth distinguishing (PLAN risk 19): gate acceptance is per
        # repository, so a token that reads antares-1b still 403s on
        # antares-350m. A generic auth error sends people to check the token,
        # which is the wrong place to look.
        raise ConversionError(
            f"{repo_id} is gated and this token has not been granted access.\n"
            f"  Accept the terms at https://huggingface.co/{repo_id}\n"
            f"  Note acceptance is PER REPOSITORY — accepting one Antares model\n"
            f"  does not grant the others."
        ) from err
    except RepositoryNotFoundError as err:
        raise ConversionError(
            f"{repo_id} does not exist, or the token cannot see it: {err}"
        ) from err
    return Path(got)


def remap_to_granite(source: Path, work: Path):
    """Rewrite granitemoehybrid as an equivalent granite checkpoint.

    Returns (source_model, granite_model) so the caller can compare them; both
    are float32 on CPU because this is the only place the two ever coexist and
    a parity check in bfloat16 would measure rounding, not correctness.
    """
    import torch
    from transformers import AutoConfig, AutoModelForCausalLM, GraniteConfig, GraniteForCausalLM

    src_cfg = AutoConfig.from_pretrained(source)
    if src_cfg.model_type != "granitemoehybrid":
        raise ConversionError(
            f"expected a granitemoehybrid checkpoint, got {src_cfg.model_type!r}. "
            "If Antares has changed architecture, this remap needs revisiting."
        )

    layer_types = list(getattr(src_cfg, "layer_types", []) or [])
    non_attention = sorted(set(layer_types) - {"attention"})
    if non_attention:
        # The whole remap rests on there being no Mamba layers. The `h-`
        # variants of Granite 4.0 genuinely are hybrids and would need real
        # SSM export support, not a tensor split.
        raise ConversionError(
            f"checkpoint has non-attention layers {non_attention}; this converter only "
            "handles the all-attention Antares/Granite configs (PLAN §11.1.2)."
        )
    if getattr(src_cfg, "num_local_experts", 0):
        raise ConversionError(
            f"checkpoint has {src_cfg.num_local_experts} experts; the remap assumes a dense MLP."
        )

    log(f"source: {src_cfg.model_type}, {len(layer_types)} layers, all attention, 0 experts")
    src_model = AutoModelForCausalLM.from_pretrained(source, dtype=torch.float32).eval()

    intermediate = getattr(src_cfg, "shared_intermediate_size", None) or src_cfg.intermediate_size
    carried = {k: getattr(src_cfg, k) for k in CARRIED_CONFIG_KEYS if hasattr(src_cfg, k)}
    dst_cfg = GraniteConfig(intermediate_size=intermediate, mlp_bias=False, **carried)
    dst_model = GraniteForCausalLM(dst_cfg).eval()

    # The split. chunk(2, dim=0) matches GraniteMoeSharedMLP.forward, which does
    # `activation(chunk[0]) * chunk[1]` — so chunk 0 is the gate and chunk 1 is
    # the up projection, in that order. Verified against the transformers source
    # rather than inferred from the name.
    remapped, split = {}, 0
    for key, tensor in src_model.state_dict().items():
        if "shared_mlp.input_linear" in key:
            gate, up = tensor.chunk(2, dim=0)
            remapped[key.replace("shared_mlp.input_linear", "mlp.gate_proj")] = gate.clone()
            remapped[key.replace("shared_mlp.input_linear", "mlp.up_proj")] = up.clone()
            split += 1
        elif "shared_mlp.output_linear" in key:
            remapped[key.replace("shared_mlp.output_linear", "mlp.down_proj")] = tensor.clone()
        else:
            remapped[key] = tensor.clone()

    missing, unexpected = dst_model.load_state_dict(remapped, strict=False)
    # Rotary inverse-frequency buffers are recomputed from config, never stored.
    missing = [m for m in missing if "rotary" not in m and "inv_freq" not in m]
    if missing or unexpected:
        raise ConversionError(
            f"state dict mismatch after remap.\n  missing: {missing[:8]}\n  unexpected: {unexpected[:8]}"
        )
    log(f"remapped {split} fused MLP tensors into gate/up pairs; state dict matched exactly")

    dst_model.save_pretrained(work, safe_serialization=True)
    for name in TOKENIZER_FILES:
        src_file = source / name
        if src_file.exists():
            shutil.copy2(src_file, work / name)
    return src_model, dst_model


def check_parity(source: Path, src_model, dst_model, tolerance: float) -> None:
    """Fail the build if the remap changed what the model predicts.

    Uses a real Antares prompt — system prompt, tool schema, chat template — so
    the comparison exercises the same token distribution the model will see in
    production, not a toy sequence.
    """
    import torch
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(source)
    prompt = tok.apply_chat_template(
        [
            {"role": "system", "content": "You are a security vulnerability localization agent."},
            {"role": "user", "content": "Find CWE-89 (SQL injection) in this repository."},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "terminal",
                    "description": "Execute a read-only terminal command in the repository.",
                    "parameters": {
                        "type": "object",
                        "properties": {"command": {"type": "string"}},
                        "required": ["command"],
                    },
                },
            }
        ],
        tokenize=False,
        add_generation_prompt=True,
    )
    ids = tok(prompt, return_tensors="pt", add_special_tokens=False).input_ids
    with torch.no_grad():
        before = src_model(ids).logits
        after = dst_model(ids).logits

    diff = (before - after).abs()
    rel = float(diff.max() / before.abs().max())
    agree = bool((before.argmax(-1) == after.argmax(-1)).all())
    log(f"prompt: {ids.shape[-1]} tokens (chat template applied, tools rendered)")
    log(f"max|diff|={float(diff.max()):.3e}  mean|diff|={float(diff.mean()):.3e}  relative={rel:.3e}")
    log(f"argmax agrees at every position: {agree}")

    if not agree or rel > tolerance:
        raise ConversionError(
            f"PARITY FAILED: relative logit difference {rel:.3e} exceeds {tolerance:.0e}, "
            f"or argmax diverged (agree={agree}).\n"
            "  The remapped model does not predict what the original predicts. Do not ship it."
        )
    log("parity OK — the remap preserves the model's predictions")


def export_onnx(work: Path, onnx_dir: Path) -> None:
    """Run optimum's exporter over the remapped (now natively supported) model."""
    cmd = [
        sys.executable, "-m", "optimum.exporters.onnx",
        "--model", str(work),
        "--task", "text-generation-with-past",
        "--opset", "17",
        "--device", "cpu",
        "--dtype", "fp32",
        str(onnx_dir),
    ]
    log(" ".join(cmd[:6]) + " ...")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-25:]
        raise ConversionError("optimum export failed:\n    " + "\n    ".join(tail))
    log("export OK")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("model", nargs="?", default="antares-350m", choices=sorted(KNOWN_MODELS))
    ap.add_argument("--tolerance", type=float, default=1e-4,
                    help="max relative logit difference accepted from the remap")
    ap.add_argument("--keep-work", action="store_true", help="keep the intermediate granite checkpoint")
    args = ap.parse_args()

    repo_id = KNOWN_MODELS[args.model]
    out = REPO_ROOT / "dist" / "models" / f"{repo_id}-ONNX"

    try:
        step(f"Resolving {repo_id}")
        source = resolve_source(args.model, repo_id)

        work_ctx = tempfile.mkdtemp(prefix="antares-granite-")
        work = Path(work_ctx)
        try:
            step("Remapping granitemoehybrid -> granite")
            src_model, dst_model = remap_to_granite(source, work)

            step(f"Checking parity (tolerance {args.tolerance:.0e})")
            check_parity(source, src_model, dst_model, args.tolerance)
            del src_model, dst_model

            step("Exporting ONNX")
            onnx_raw = work / "onnx-export"
            export_onnx(work, onnx_raw)

            step("Quantizing and assembling")
            from quantize_onnx import assemble  # local module, same directory
            assemble(source=source, granite=work, onnx_raw=onnx_raw, out=out)
        finally:
            if args.keep_work:
                log(f"work dir kept: {work}")
            else:
                shutil.rmtree(work, ignore_errors=True)

        step("Done")
        log(f"output: {out}")
        return 0
    except ConversionError as err:
        print(f"\nerror: {err}\n", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
