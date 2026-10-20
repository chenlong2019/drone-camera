"""Windows regression checks: python scripts/test-colmap-reconstruction.py.

Runs the real PowerShell entry point with a fake native COLMAP command; no GPU
or photogrammetry install is needed. Real COLMAP results must be tested separately.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("run-colmap-reconstruction.ps1").resolve()
FAKE_COLMAP = r'''
import json, os, pathlib, struct, sys
args = sys.argv[1:]
scenario = os.environ["COLMAP_TEST_SCENARIO"]
with open(os.environ["COLMAP_TEST_TRACE"], "a", encoding="utf-8") as trace:
    trace.write(json.dumps(args) + "\n")
if "-h" in args:
    gpu = "without" if scenario.startswith("cpu") else "with"
    capability = "CUDA" if scenario == "cpu-legacy" else "GPU support"
    print(f"COLMAP 4.2.1 ({gpu} {capability})", file=sys.stderr)
    if scenario == "help-failure":
        print("missing runtime library", file=sys.stderr)
        sys.exit(17)
    if args[0] == "feature_extractor":
        print("--SiftExtraction.use_gpu" if scenario == "legacy" else "--FeatureExtraction.use_gpu")
    if args[0] == "exhaustive_matcher":
        print("--SiftMatching.use_gpu" if scenario == "legacy" else "--FeatureMatching.use_gpu")
    sys.exit(0)
print("normal native progress on stderr", file=sys.stderr)
if scenario == "stage-failure" and args[0] == "feature_extractor":
    print("feature extraction diagnostic", file=sys.stderr)
    sys.exit(23)
if args[0] == "mapper":
    root = pathlib.Path(args[args.index("--output_path") + 1])
    # Model 0 is larger on disk but has fewer reconstructed points.
    models = [("0", 3, 1, 4096)]
    if scenario != "small":
        models.append(("1", 8, 150, 0))
    for name, images, points, padding in models:
        model = root / name
        model.mkdir(parents=True)
        (model / "images.bin").write_bytes(struct.pack("<Q", images) + b"x" * padding)
        (model / "points3D.bin").write_bytes(struct.pack("<Q", points) + b"x" * padding)
'''


@unittest.skipUnless(os.name == "nt", "requires Windows PowerShell")
class ReconstructionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="colmap helper test ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.capture = self.root / "capture"
        (self.capture / "images").mkdir(parents=True)
        images = []
        for i in range(8):
            file = f"images/{i}.png"
            (self.capture / file).touch()
            images.append({"file": file})
        (self.capture / "manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "captureId": "regression", "images": images,
            "camera": {"model": "PINHOLE", "fx": 800, "fy": 800, "cx": 480, "cy": 270},
        }), encoding="utf-8")
        self.fake = self.root / "fake-colmap.cmd"
        (self.root / "fake.py").write_text(FAKE_COLMAP, encoding="utf-8")
        self.fake.write_text(f'@echo off\n"{sys.executable}" "%~dp0fake.py" %*\n', encoding="utf-8")
        self.trace = self.root / "calls.jsonl"
        self.output = self.capture / "reconstruction"

    def run_helper(self, scenario, *extra):
        result = subprocess.run([
            "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT),
            "-CaptureDir", str(self.capture), "-ColmapExe", str(self.fake), *extra,
        ], env={**os.environ, "COLMAP_TEST_SCENARIO": scenario, "COLMAP_TEST_TRACE": str(self.trace)},
            capture_output=True, timeout=45)
        report_path = self.output / "reconstruction-report.json"
        self.assertTrue(report_path.exists(), result.stdout + result.stderr)
        report = json.loads(report_path.read_text(encoding="utf-8-sig"))
        calls = [json.loads(line) for line in self.trace.read_text(encoding="utf-8").splitlines()]
        log = (self.output / "reconstruction.log").read_text(encoding="utf-8-sig")
        return result.returncode, report, calls, log

    def test_cpu_build_stops_before_cleanup_even_with_overrides(self):
        self.output.mkdir()
        old_database = self.output / "database.db"
        old_database.write_bytes(b"previous results")
        code, report, calls, log = self.run_helper("cpu", "-UseGpu", "-AllowSmallSparseModel")
        self.assertEqual(code, 1)
        self.assertEqual(report["stage"], "environment")
        self.assertFalse(report["gpuBuild"])
        self.assertEqual(calls, [["-h"]])
        self.assertEqual(old_database.read_bytes(), b"previous results")
        self.assertIn("no GPU support", report["errors"][0])
        self.assertIn("without GPU support", log)

    def test_selects_actual_point_count_and_accepts_normal_stderr(self):
        code, report, calls, log = self.run_helper("modern")
        self.assertEqual(code, 0)
        self.assertEqual(report["sparseModel"], "1")
        self.assertEqual(report["registeredImages"], 8)
        self.assertEqual(report["sparsePoints"], 150)
        feature = next(c for c in calls if c[0] == "feature_extractor" and "-h" not in c)
        self.assertIn("--FeatureExtraction.use_gpu", feature)
        self.assertEqual(feature[-1], "0")
        self.assertIn("normal native progress on stderr", log)
        self.assertEqual(calls[-1][0], "poisson_mesher")

    def test_older_without_cuda_banner_is_also_blocked(self):
        code, report, calls, _ = self.run_helper("cpu-legacy")
        self.assertEqual(code, 1)
        self.assertEqual(report["stage"], "environment")
        self.assertFalse(report["gpuBuild"])
        self.assertEqual(calls, [["-h"]])

    def test_legacy_gpu_option_names(self):
        code, _, calls, _ = self.run_helper("legacy", "-UseGpu")
        self.assertEqual(code, 0)
        for command, option in (("feature_extractor", "--SiftExtraction.use_gpu"),
                                ("exhaustive_matcher", "--SiftMatching.use_gpu")):
            args = next(c for c in calls if c[0] == command and "-h" not in c)
            self.assertIn(option, args)
            self.assertEqual(args[-1], "1")

    def test_small_model_is_reported_without_entering_dense(self):
        code, report, calls, _ = self.run_helper("small")
        self.assertEqual(code, 1)
        self.assertEqual(report["stage"], "sparse-quality")
        self.assertEqual(report["registeredImages"], 3)
        self.assertEqual(report["sparsePoints"], 1)
        self.assertFalse(any(c[0] == "patch_match_stereo" for c in calls))
        self.assertTrue((self.output / "sparse" / "0" / "points3D.bin").exists())

    def test_native_failure_keeps_exit_code_and_stderr(self):
        code, report, _, log = self.run_helper("stage-failure")
        self.assertEqual(code, 1)
        self.assertEqual(report["stage"], "feature-extraction")
        self.assertIn("exit code 23", report["errors"][0])
        self.assertIn("feature extraction diagnostic", log)

    def test_help_failure_is_reported(self):
        code, report, calls, log = self.run_helper("help-failure")
        self.assertEqual(code, 1)
        self.assertEqual(report["stage"], "environment")
        self.assertIn("exit code 17", report["errors"][0])
        self.assertIn("missing runtime library", log)
        self.assertEqual(calls, [["-h"]])


if __name__ == "__main__":
    unittest.main()
