"""Check a converted Antares build still behaves like the original checkpoint.

Two different questions, deliberately measured differently:

- The **remap** must be exact. It reorganises tensors without changing any
  value, so anything but near-bit-identical logits is a bug. That check lives in
  convert_antares.py and gates the build.
- The **quantization** must be faithful, not exact. int4 weights change every
  logit slightly and by design, so comparing logits to a tolerance would either
  pass everything or fail everything. What matters is whether it still makes the
  same decisions: greedy agreement over a real Antares prompt, and whether the
  continuation is still a well-formed tool call.

Run via `make antares-verify`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

PROMPT_MESSAGES = [
    {
        "role": "system",
        "content": (
            "You are a security vulnerability localization agent. You have read-only "
            "terminal access to a codebase.\n\nGiven a CWE (Common Weakness Enumeration) "
            "description, your task is to determine whether this codebase contains a "
            "vulnerability matching that CWE class, and if so, identify which source "
            "file(s) are vulnerable.\n\nYou can explore the codebase using the `terminal` "
            "tool. You have up to 15 repository tool calls."
        ),
    },
    {
        "role": "user",
        "content": (
            "Search this repository for vulnerabilities matching: CWE-89 (SQL Injection). "
            "The repository is mounted at /mnt/host. Read source files, identify vulnerable "
            "code patterns, and submit ranked vulnerable file paths only."
        ),
    },
]

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "terminal",
            "description": (
                "Execute a read-only terminal command in the repository. Supports standard "
                "file navigation, search, and inspection utilities. Read-only access only. "
                "Output is truncated to max_chars."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to run"},
                    "max_chars": {
                        "type": "integer",
                        "description": "Maximum number of output characters before truncation (default: 2000)",
                        "default": 2000,
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_vulnerable_files",
            "description": (
                "Submit your answer: a ranked list of file paths you believe contain the "
                "vulnerability. Paths relative to repository root."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "ranked_files": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Ordered list of file paths",
                    }
                },
                "required": ["ranked_files"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_no_vulnerability_found",
            "description": "Declare that no vulnerability matching the CWE description was found in this codebase.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


def log(msg: str) -> None:
    print(f"  {msg}", file=sys.stderr, flush=True)


def build_prompt(tokenizer) -> str:
    return tokenizer.apply_chat_template(
        PROMPT_MESSAGES, tools=TOOLS, tokenize=False, add_generation_prompt=True
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="dist/models/fdtn-ai/antares-350m")
    ap.add_argument("--onnx", default="dist/models/fdtn-ai/antares-350m-ONNX")
    ap.add_argument(
        "--dtype",
        default="q4",
        help="which ONNX variant to check: fp32 (the reference graph), q8, q4, ...",
    )
    ap.add_argument("--tokens", type=int, default=48)
    ap.add_argument("--min-agreement", type=float, default=0.80)
    args = ap.parse_args()

    import torch
    from optimum.onnxruntime import ORTModelForCausalLM
    from transformers import AutoModelForCausalLM, AutoTokenizer

    source = REPO_ROOT / args.source
    onnx_dir = REPO_ROOT / args.onnx

    tokenizer = AutoTokenizer.from_pretrained(source)
    prompt = build_prompt(tokenizer)
    ids = tokenizer(prompt, return_tensors="pt", add_special_tokens=False).input_ids
    log(f"prompt: {ids.shape[-1]} tokens, ends with {prompt[-24:]!r}")

    print("\n==> Reference (safetensors, float32, greedy)", file=sys.stderr)
    ref = AutoModelForCausalLM.from_pretrained(source, dtype=torch.float32).eval()
    with torch.no_grad():
        ref_out = ref.generate(
            ids, max_new_tokens=args.tokens, do_sample=False,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )
    ref_new = ref_out[0, ids.shape[-1]:]
    ref_text = tokenizer.decode(ref_new, skip_special_tokens=False)
    log(f"reference continuation:\n{'-'*66}\n{ref_text}\n{'-'*66}")
    del ref

    print(f"\n==> Converted ONNX ({args.dtype}, greedy)", file=sys.stderr)
    # transformers.js file naming, which the output directory follows: fp32 is
    # plain `model.onnx` and int8 is `model_quantized.onnx`, not `model_fp32` /
    # `model_q8`. Everything else is `model_<dtype>.onnx`.
    special = {"fp32": "model.onnx", "": "model.onnx", "q8": "model_quantized.onnx"}
    file_name = special.get(args.dtype, f"model_{args.dtype}.onnx")
    onnx_model = ORTModelForCausalLM.from_pretrained(
        onnx_dir, file_name=file_name, use_cache=True,
    )
    got = onnx_model.generate(
        ids, max_new_tokens=args.tokens, do_sample=False,
        pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
    )
    got_new = got[0, ids.shape[-1]:]
    got_text = tokenizer.decode(got_new, skip_special_tokens=False)
    log(f"onnx continuation:\n{'-'*66}\n{got_text}\n{'-'*66}")

    print("\n==> Fidelity (greedy, deterministic)", file=sys.stderr)
    n = min(len(ref_new), len(got_new))
    same = sum(1 for i in range(n) if int(ref_new[i]) == int(got_new[i]))
    agreement = same / n if n else 0.0
    prefix = 0
    for i in range(n):
        if int(ref_new[i]) != int(got_new[i]):
            break
        prefix += 1
    log(f"greedy token agreement: {same}/{n} = {agreement:.1%}")
    log(f"identical prefix length: {prefix} tokens")

    # Greedy is right for comparing two models and wrong for asking whether the
    # model works: at temperature 0 this checkpoint degenerates into repeating
    # "I will inspect the ..." forever and never reaches a tool call. That is not
    # a conversion defect — it is why Antares specifies temperature 0.3 and a
    # frequency penalty (PLAN §11.1.12). So behaviour is measured under the
    # model's own sampling settings, seeded for reproducibility.
    print("\n==> Behaviour (Antares sampling: temp 0.3, top_p 1.0)", file=sys.stderr)
    torch.manual_seed(0)
    sampled = onnx_model.generate(
        ids,
        max_new_tokens=max(args.tokens, 160),
        do_sample=True,
        temperature=0.3,
        top_p=1.0,
        repetition_penalty=1.05,
        pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
    )
    sampled_text = tokenizer.decode(sampled[0, ids.shape[-1]:], skip_special_tokens=False)
    log(f"sampled continuation:\n{'-'*66}\n{sampled_text}\n{'-'*66}")
    emits_call = "<tool_call>" in sampled_text
    log(f"emits a <tool_call> block: {emits_call}")

    failures = []
    if agreement < args.min_agreement:
        failures.append(f"greedy agreement {agreement:.1%} is below {args.min_agreement:.0%}")
    if not emits_call:
        failures.append(
            "no <tool_call> block in the continuation "
            "(raise --tokens if the model is still reasoning at the cutoff)"
        )
    if failures:
        print("\nFAIL: " + "; ".join(failures) + "\n", file=sys.stderr)
        return 1
    print("\nOK: the converted model tracks the reference and still emits tool calls.\n", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
