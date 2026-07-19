#!/usr/bin/env python3
"""Validate the final Wheel ZOB documentation corpus and frozen scope manifest."""

from __future__ import annotations

import ast
import hashlib
import json
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path
from typing import Iterable

ZOB_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ZOB_ROOT.parents[1]
REVIEW_ROOT = ZOB_ROOT / "reviews" / "staging-design-2026-07-18"
SCOPE_PATH = ZOB_ROOT / "reviews" / "consolidated-2026-07-18" / "SCOPE_MANIFEST.json"
SOURCE_SUFFIXES = {".md", ".json", ".py", ".html"}


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def source_paths() -> list[Path]:
    paths = [REPO_ROOT / "AGENTS.md", REPO_ROOT / "README.md"]
    for path in sorted(ZOB_ROOT.rglob("*")):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        if ZOB_ROOT / "reviews" in path.parents or "__pycache__" in path.parts:
            continue
        paths.append(path)
    return paths


def file_record(path: Path) -> dict[str, object]:
    data = path.read_bytes()
    return {
        "path": path.relative_to(REPO_ROOT).as_posix(),
        "lineCount": len(data.decode("utf-8").splitlines()),
        "byteCount": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def validate_scope() -> None:
    scope = json.loads(SCOPE_PATH.read_text())
    actual = {record["path"]: record for record in map(file_record, source_paths())}
    expected = {item["path"]: item for item in scope["files"]}
    check(set(actual) == set(expected), f"scope path drift missing={set(actual)-set(expected)} stale={set(expected)-set(actual)}")
    for path, record in actual.items():
        scoped = expected[path]
        for key in ("lineCount", "byteCount", "sha256"):
            check(record[key] == scoped[key], f"scope {key} drift for {path}")
    check(scope["fileCount"] == len(actual), "scope fileCount drift")
    check(scope["lineCount"] == sum(item["lineCount"] for item in actual.values()), "scope lineCount drift")
    check(scope["byteCount"] == sum(item["byteCount"] for item in actual.values()), "scope byteCount drift")
    check(scope.get("lineCountSemantics") == "utf8-splitlines-logical-lines", "scope line-count convention is not explicit")
    print(f"SCOPE_FRESHNESS_PASS files={scope['fileCount']} lines={scope['lineCount']} bytes={scope['byteCount']}")


def heading_anchors(path: Path) -> set[str]:
    anchors: set[str] = set()
    for line in path.read_text().splitlines():
        match = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if not match:
            continue
        anchor = re.sub(r"<[^>]+>", "", match.group(1)).strip().lower()
        anchor = re.sub(r"[^\w\- ]", "", anchor).replace(" ", "-")
        anchors.add(re.sub(r"-+", "-", anchor))
    return anchors


def markdown_paths() -> list[Path]:
    return [path for path in source_paths() if path.suffix == ".md"]


def is_markdown_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in {".md", ".markdown"}


def validate_links() -> None:
    pattern = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
    local_count = 0
    for path in markdown_paths():
        for raw in pattern.findall(path.read_text()):
            if raw.startswith(("http://", "https://", "mailto:")):
                continue
            local_count += 1
            target, _, anchor = raw.partition("#")
            destination = (path.parent / urllib.parse.unquote(target)).resolve() if target else path.resolve()
            check(destination.exists(), f"broken local link {path.relative_to(REPO_ROOT)} -> {raw}")
            if anchor and is_markdown_file(destination):
                check(urllib.parse.unquote(anchor).lower() in heading_anchors(destination), f"broken anchor {path.relative_to(REPO_ROOT)} -> {raw}")
    print(f"MARKDOWN_LINK_PASS docs={len(markdown_paths())} local_links={local_count}")


def linked_targets(index: Path) -> set[str]:
    pattern = re.compile(r"\[[^\]]*\]\(([^)#]+)(?:#[^)]+)?\)")
    return {match for match in pattern.findall(index.read_text()) if not match.startswith(("http://", "https://"))}


def validate_index_coverage() -> None:
    index = ZOB_ROOT / "README.md"
    linked = linked_targets(index)
    required = {path.name for path in ZOB_ROOT.glob("*.md") if path.name != "README.md"}
    for name in required:
        check(name in linked, f"documentation index omits {name}")
    schema_readme = (ZOB_ROOT / "schemas" / "README.md").read_text()
    example_readme = (ZOB_ROOT / "examples" / "README.md").read_text()
    for path in (ZOB_ROOT / "schemas").glob("*.schema.json"):
        check(path.name in schema_readme, f"schema README omits {path.name}")
    for path in (ZOB_ROOT / "examples").glob("*.example.json"):
        check(path.name in example_readme, f"example README omits {path.name}")
    check("validation/validate_contracts.py" in linked, "documentation index omits contract validator")
    check("validation/validate_documentation.py" in linked, "documentation index omits documentation validator")
    print(f"INDEX_COVERAGE_PASS top_level_docs={len(required)+1}")


def validate_decisions() -> None:
    text = (ZOB_ROOT / "16-DECISIONS.md").read_text()
    ids = [int(value) for value in re.findall(r"^\|\s*ZOB-D-(\d{3})\s*\|", text, re.MULTILINE)]
    check(ids == list(range(1, 127)), "decision table rows are not exactly ordered 001..126")
    check(len(ids) == len(set(ids)), "duplicate decision table rows")
    check("superseded" in text[text.index("ZOB-D-081") - 500 : text.index("ZOB-D-095") + 500], "direct-develop decisions are not visibly superseded")
    print(f"DECISION_ID_PASS rows={len(ids)}")


def enhancement_blocks(text: str) -> Iterable[tuple[int, str]]:
    matches = list(re.finditer(r"^### ZOB-ENH-(\d{3})\b", text, re.MULTILINE))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        yield int(match.group(1)), text[match.start() : end]


def validate_enhancements() -> None:
    text = (ZOB_ROOT / "ENHANCEMENTS.md").read_text()
    blocks = list(enhancement_blocks(text))
    ids = [item[0] for item in blocks]
    check(sorted(ids) == list(range(1, 38)), "enhancement IDs are not exactly 001..037")
    check(len(ids) == len(set(ids)), "duplicate enhancement IDs")
    for identifier, block in blocks:
        for field in ("Status", "Value", "Dependencies", "Acceptance", "Promotion trigger"):
            check(f"**{field}:**" in block, f"ENH-{identifier:03d} lacks {field}")
    for identifier in (31, 32):
        block = dict(blocks)[identifier]
        check("Promoted-to-v1-design" in block, f"ENH-{identifier:03d} is not promoted")
    check("Research; supporting the promoted ENH-032" in dict(blocks)[33], "ENH-033 maturity is unclear")
    print(f"ENHANCEMENT_ID_FIELD_PASS count={len(blocks)}")


def validate_policy_assertions() -> None:
    section = (ZOB_ROOT / "17-STAGING_ASSURANCE_AND_PROMOTION_FACTORY.md").read_text()
    required = [
        "ordinary PR base:       develop-staging",
        "staging deployment:     forbidden",
        "Only a human may start a promotion window",
        "Maximum three full assurance rounds means at most two automatic repair transitions",
        "The sole merge exception is a repair PR bound to a validated finding",
        "The aligned SHA is new",
        "merge-commit",
        "never manually runs `workflow_dispatch`",
        "Staging Merge App",
        "Promotion App",
    ]
    for phrase in required:
        check(phrase in section, f"section 17 lacks policy assertion: {phrase}")
    source = (ZOB_ROOT / "SOURCE_EVIDENCE.md").read_text()
    check("refs/heads/develop-staging:  absent" in source, "current staging-branch absence is not recorded")
    check("Approved design / Specified only" in source, "staging design is not maturity-qualified")
    active_examples = ["mission.example.json", "story-execution.example.json", "pr-close-evidence.example.json", "blind-review-result.example.json"]
    for name in active_examples:
        check("develop-staging" in (ZOB_ROOT / "examples" / name).read_text(), f"active example {name} bypasses staging")
    legacy = (ZOB_ROOT / "examples" / "merge-authorization.example.json").read_text()
    check('"targetBranch": "develop"' in legacy, "legacy compatibility fixture changed unexpectedly")
    check('"migrationReadOnly": true' in legacy and '"migrationDisposition": "historical-only"' in legacy, "legacy fixture is not read-only")
    schema_readme = (ZOB_ROOT / "schemas" / "README.md").read_text().lower()
    check("legacy direct-base" in schema_readme and "read-only migration" in schema_readme, "legacy fixture is not clearly fail-closed")
    print("STAGING_POLICY_ASSERTIONS_PASS")


def validate_body_policy_and_python() -> None:
    current_text = "\n".join(path.read_text(errors="replace") for path in source_paths())
    for path in source_paths():
        if path.suffix == ".py":
            ast.parse(path.read_text(), filename=str(path))
    check("bodyStored" in current_text and "raw prompts" in current_text.lower(), "body-safe policy disappeared")
    check("Never use real family-member names" in (REPO_ROOT / "AGENTS.md").read_text(), "privacy naming policy disappeared")
    print("BODY_POLICY_PYTHON_PARSE_PASS")


def run_contract_validator() -> None:
    command = [sys.executable, str(ZOB_ROOT / "validation" / "validate_contracts.py")]
    result = subprocess.run(command, cwd=REPO_ROOT, text=True, capture_output=True, check=False)
    check(result.returncode == 0, f"contract validator failed: {result.stdout}\n{result.stderr}")
    print(result.stdout.strip())


def main() -> None:
    validate_scope()
    validate_links()
    validate_index_coverage()
    validate_decisions()
    validate_enhancements()
    validate_policy_assertions()
    validate_body_policy_and_python()
    run_contract_validator()
    print("DOCUMENTATION_VALIDATION_PASS")


if __name__ == "__main__":
    main()
