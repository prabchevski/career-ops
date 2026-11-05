"""Verify the exact failed parent run before a compiled-only continuation."""
import argparse
import hashlib
from functools import lru_cache
import io
import json
import os
from pathlib import Path
import subprocess
import zipfile

REPO = "prabchevski/career-ops"
RUN = 42098051721
HEAD = "38403467ff7c7eaf6219aee634e22c325013b5e6"
SOURCE = "17e65cbeff8b6367518de97863b74381cb826941"
SOURCE_JOB = "Exact source (workday)"
FAILED_STEP = "Execute exact emitted helper and adapter functions with fictional data"
GREEN_JOBS = {"Exact source (geo)", "Exact source (tracker)", "Exact source (himalayas)", "Exact source (archive)", "Real native interop (Node 22.13.0)", "Real native interop (Node 24)"}
GREEN_STEPS = ["Attest head, all PR source hashes, native inventory and incremental scope", "Workday source and actual route contract before web dependencies", "Workday full root suite once before web dependencies", "Workday full web tests", "Workday typecheck", "Workday production build", "Re-attest immutable source after checks, including on failure"]
ARTIFACT = f"exact-source-workday-{HEAD}"


def known_collector_failure(log):
    assert "compiled-workday-proof.mjs:84:14" in log
    assert "assert.ok(ids.length && ['ArrowFunctionExpression', 'FunctionExpression'].includes(n?.type))" in log
    assert "AssertionError [ERR_ASSERTION]" in log


def validate(run, jobs, artifact, attestation, axis, log):
    known_collector_failure(log)
    assert run["id"] == RUN and run["head_sha"] == HEAD
    assert run["head_branch"] == "codex/verify-workday-geo-tracker-20261105"
    assert run["repository"]["full_name"] == REPO
    assert run["run_attempt"] == 1 and run["status"] == "completed"
    assert run["conclusion"] == "failure", "retain the original overall failure"
    assert len(jobs) == 7 and {j["name"] for j in jobs} == GREEN_JOBS | {SOURCE_JOB}
    for job in jobs:
        assert job["status"] == "completed"
        assert job["conclusion"] == ("failure" if job["name"] == SOURCE_JOB else "success")
    source = next(j for j in jobs if j["name"] == SOURCE_JOB)
    steps = {s["name"]: s["conclusion"] for s in source["steps"]}
    assert all(steps[name] == "success" for name in GREEN_STEPS)
    assert [s["name"] for s in source["steps"] if s["conclusion"] == "failure"] == [FAILED_STEP]
    assert artifact["name"] == ARTIFACT and artifact["expired"] is False
    assert artifact["workflow_run"]["id"] == RUN and artifact["workflow_run"]["head_sha"] == HEAD
    assert 0 < artifact["size_in_bytes"] <= 128 * 1024
    assert axis["head"] == SOURCE and len(axis["files"]) == 16
    for key in ["head", "base", "parent", "scope", "files"]:
        assert attestation[key] == axis[key], f"parent source attestation mismatch: {key}"
    assert attestation["noWebDependenciesAtInitialAttestation"] is True
    return {"status": "parent-failure-scope-verified", "parentRunId": RUN, "parentHead": HEAD, "parentAttempt": 1,
            "originalOverallConclusion": "failure", "sourceHead": SOURCE, "sixOtherJobs": "success",
            "sourceProductSteps": {name: steps[name] for name in GREEN_STEPS}, "onlyFailedStep": FAILED_STEP,
            "sourceFiles": axis["files"], "scope": "compiled-only continuation; no new full-suite claim"}


@lru_cache(maxsize=1)
def captured_binary_flags():
    # New gh protects terminal content even when captured. Preserve raw bytes
    # only for data held in memory, never rendered to a terminal.
    help_bytes = subprocess.check_output(["gh", "api", "--help"], timeout=15)
    assert len(help_bytes) <= 128 * 1024
    return ["--allow-escape-sequences"] if b"--allow-escape-sequences" in help_bytes else []


def api(resource, binary=False, cap=2 * 1024 * 1024):
    value = subprocess.check_output(["gh", "api", "--method", "GET", *(captured_binary_flags() if binary else []), f"repos/{REPO}/{resource}"], timeout=45)
    assert len(value) <= cap, "bounded GitHub response"
    return value if binary else json.loads(value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--axes", required=True)
    parser.add_argument("--proof", required=True)
    args = parser.parse_args()
    run = api(f"actions/runs/{RUN}")
    listed_jobs = api(f"actions/runs/{RUN}/jobs?per_page=100")
    assert listed_jobs["total_count"] == len(listed_jobs["jobs"]) == 7
    listed_artifacts = api(f"actions/runs/{RUN}/artifacts?per_page=100")
    assert listed_artifacts["total_count"] == len(listed_artifacts["artifacts"]) <= 100
    selected = [a for a in listed_artifacts["artifacts"] if a["name"] == ARTIFACT]
    assert len(selected) == 1
    artifact = selected[0]
    assert 0 < artifact["size_in_bytes"] <= 128 * 1024
    archive_bytes = api(f"actions/artifacts/{int(artifact['id'])}/zip", binary=True)
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        members = archive.infolist()
        assert len(members) == 1 and members[0].filename == "source-attestation.json"
        assert members[0].file_size <= 64 * 1024 and (members[0].external_attr >> 16) & 0o170000 != 0o120000
        raw = archive.read(members[0])
    attestation = json.loads(raw)
    axis = json.loads(Path(args.axes).read_text())["workday"]
    source = next(j for j in listed_jobs["jobs"] if j["name"] == SOURCE_JOB)
    log = api(f"actions/jobs/{int(source['id'])}/logs", binary=True, cap=16 * 1024 * 1024)
    proof = validate(run, listed_jobs["jobs"], artifact, attestation, axis, log.decode("utf8"))
    proof["parentArtifactId"] = artifact["id"]
    proof["parentAttestationSha256"] = hashlib.sha256(raw).hexdigest()
    proof["parentJobLogSha256"] = hashlib.sha256(log).hexdigest()
    proof["knownOriginalCollectorFailureVerified"] = True
    os.umask(0o077)
    with open(args.proof, "x", encoding="utf8") as handle:
        json.dump(proof, handle, indent=2)
        handle.write("\n")
    print(json.dumps({"status": proof["status"], "originalOverallConclusion": "failure", "sourceHead": SOURCE, "parentRunId": RUN}))


if __name__ == "__main__":
    main()
