"""Offline numerical/identity regression tests for the PRI-3088 readout.

Run: python3 docs/experiments/2026-09-04-astra-sol-readout-test.py
"""

import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
SCRIPT = HERE / '2026-09-04-astra-sol-readout.py'


class ReadoutTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.exists(), 'offline readout implementation is missing')
        spec = importlib.util.spec_from_file_location('readout', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(prefix='pri-3088-test-input-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.slots = [dict(pair_id=f's:r{rep}', scenario='s', replicate=rep,
                           arm=arm, model=f'model-{arm}', credential=f'cred-{arm}')
                      for rep in [1, 2] for arm in ['sol', 'astra']]
        self.jobs = [dict(replicate=rep, arm=arm, job_id=f'job-{rep}-{arm}',
                          batch_id=f'batch-{rep}-{arm}')
                     for rep in [1, 2] for arm in ['sol', 'astra']]
        self.put('planned-manifest.json', dict(experiment='test', reasoning_effort='high',
                 agent='codex', slots=self.slots))
        self.put('state.json', dict(measured_jobs=self.jobs, smoke_jobs=[]))

    def put(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value))

    def attempt(self, rep, arm, cost, outcome='pass', seconds=10, suffix=''):
        job = f'job-{rep}-{arm}'
        run = f'run-{rep}-{arm}{suffix}'
        base = f'measured/{job}'
        self.put(f'{base}/batch.json', dict(id=f'batch-{rep}-{arm}',
                 started_at='2026-09-04T00:00:00Z', finished_at='2026-09-04T00:01:00Z'))
        self.put(f'{base}/runs/{run}/verdict.json', dict(schema=1, scenario='s',
                 coding_agent='codex', credential=f'cred-{arm}', final=outcome,
                 started_at='2026-09-04T00:00:00Z',
                 finished_at=f'2026-09-04T00:00:{seconds:02d}Z',
                 gauntlet=dict(status='pass'), checks=[dict(phase='post', passed=outcome != 'fail')],
                 economics=dict(gauntlet=dict(est_cost_usd=0.25, has_unpriced_model=False))))
        self.put(f'{base}/runs/{run}/observed-config.json', dict(model=f'model-{arm}', reasoning_effort='high'))
        self.put(f'{base}/runs/{run}/repriced-coding.json', dict(total_usd=cost, per_model=[],
                 unpriced_models=[] if cost is not None else ['unknown'], approximations=[]))
        self.put(f'{base}/runs/{run}/capture-coverage.json', dict(
                 schema='pri-3088.capture-coverage/v1', available_log_coverage_complete=True,
                 verdict='complete_for_available_logs', issues=[]))
        record = dict(scenario='s', coding_agent='codex', credential=f'cred-{arm}', run_id=run)
        with (self.root / base / 'results.jsonl').open('a') as f:
            f.write(json.dumps(record) + '\n')
        return f'{base}/runs/{run}'

    def test_opposite_missing_cost_removes_both_arms_from_cost_comparison(self):
        self.attempt(1, 'sol', 1)
        self.attempt(1, 'astra', 2)
        self.attempt(2, 'sol', 100)
        self.attempt(2, 'astra', None)
        report = self.module.build_report(self.root)
        row = report['comparisons'][0]
        self.assertEqual(row['behavior']['pair_n'], 2)
        self.assertEqual(row['subject_usd']['pair_n'], 1)
        self.assertEqual(row['subject_usd']['sol_median'], 1)
        self.assertEqual(row['subject_usd']['astra_median'], 2)
        self.assertEqual(row['subject_usd']['median_paired_delta'], 1)
        self.assertEqual(row['wall_seconds']['pair_n'], 2)
        self.assertEqual(report['accounting']['by_arm']['sol']['subject_usd']['known_subtotal'], 101)

    def test_indeterminate_work_is_accounted_but_not_behaviorally_comparable(self):
        self.attempt(1, 'sol', 3, 'indeterminate')
        self.attempt(1, 'astra', 4, 'pass')
        report = self.module.build_report(self.root)
        self.assertEqual(report['planned_slot_n'], 4)
        self.assertEqual(report['comparisons'][0]['behavior']['pair_n'], 0)
        self.assertEqual(report['accounting']['all_attempts']['subject_usd']['known_subtotal'], 7)
        self.assertEqual(report['accounting']['all_attempts']['wall_seconds']['known_subtotal'], 20)
        self.assertEqual(report['accounting']['noncomparable_attempt_n'], 2)

    def test_uncollected_slots_are_preserved_without_claiming_never_started(self):
        report = self.module.build_report(self.root)
        self.assertEqual(len(report['slots']), 4)
        self.assertTrue(all(s['outcome'] == 'unobserved' for s in report['slots']))
        self.assertTrue(all(s['observation_status'] == 'job_uncollected' for s in report['slots']))
        self.assertEqual(report['accounting']['all_attempts']['subject_usd']['expected_n'], 0)

    def test_duplicate_attempts_do_not_silently_choose_a_winner(self):
        self.attempt(1, 'sol', 1, 'pass')
        self.attempt(1, 'sol', 5, 'fail', suffix='-retry')
        self.attempt(1, 'astra', 2)
        report = self.module.build_report(self.root)
        slot = report['slots'][0]
        self.assertEqual(slot['observation_status'], 'ambiguous_attempts')
        self.assertEqual(slot['outcome'], 'unobserved')
        self.assertEqual(report['comparisons'][0]['behavior']['pair_n'], 0)
        self.assertEqual(report['accounting']['all_attempts']['subject_usd']['known_subtotal'], 8)

    def test_disagreements_and_models_are_reported_without_raw_transcripts(self):
        run = self.attempt(1, 'sol', 1, 'fail')
        self.put(f'{run}/trajectory.json', dict(steps=[dict(model_name='model-sol', text='SECRET_TEXT'),
                                                        dict(model_name='helper-model')]))
        report = self.module.build_report(self.root)
        self.assertTrue(report['slots'][0]['disagreement'])
        self.assertEqual(report['observed_model_mix']['sol'], ['helper-model', 'model-sol'])
        self.assertNotIn('SECRET_TEXT', json.dumps(report))

    def test_smokes_are_separate_from_measured_cost_and_denominators(self):
        self.put('state.json', dict(measured_jobs=[], smoke_jobs=[dict(model='model-astra', job_id='smoke')]))
        self.put('smokes/astra/repriced-coding.json', dict(total_usd=99, per_model=[], unpriced_models=[]))
        report = self.module.build_report(self.root)
        self.assertEqual(report['planned_slot_n'], 4)
        self.assertEqual(report['accounting']['all_attempts']['subject_usd']['known_subtotal'], 0)
        self.assertEqual(report['smokes']['accounting']['subject_usd']['known_subtotal'], 99)

    def test_partial_repricing_is_subtotal_only_and_negative_duration_is_missing(self):
        run = self.attempt(1, 'sol', 1)
        self.put(f'{run}/repriced-coding.json', dict(total_usd=1, per_model=[], unpriced_models=['x']))
        verdict = json.loads((self.root / run / 'verdict.json').read_text())
        verdict['finished_at'] = '2026-09-03T23:59:59Z'
        self.put(f'{run}/verdict.json', verdict)
        report = self.module.build_report(self.root)
        account = report['accounting']['all_attempts']
        self.assertEqual(account['subject_usd']['known_subtotal'], 1)
        self.assertEqual(account['subject_usd']['known_n'], 0)
        self.assertEqual(account['wall_seconds']['known_n'], 0)

    def test_model_or_effort_mismatch_excludes_comparisons(self):
        run = self.attempt(1, 'sol', 1)
        self.put(f'{run}/observed-config.json', dict(model='wrong-model', reasoning_effort='high'))
        self.attempt(1, 'astra', 2)
        report = self.module.build_report(self.root)
        self.assertEqual(report['slots'][0]['outcome'], 'pass')
        self.assertFalse(report['slots'][0]['comparison_eligible'])
        self.assertEqual(report['comparisons'][0]['behavior']['pair_n'], 0)

    def test_same_execution_fingerprint_ignores_container_but_not_image_change(self):
        for arm in ['sol', 'astra']:
            self.attempt(1, arm, 1)
            self.put(f'measured/job-1-{arm}/provenance.json', dict(
                refs=dict(evals_resolved_sha='evals', superpowers_resolved_sha='skills', gauntlet_built_sha='grader'),
                credential_bundle=dict(bundle_id='blessed'),
                container=dict(id=f'different-{arm}', image_id='same-image', mount_signature=arm),
                tool_versions_text='codex: fixed'))
        report = self.module.build_report(self.root)
        self.assertEqual(report['comparisons'][0]['behavior']['pair_n'], 1)
        path = 'measured/job-1-astra/provenance.json'
        provenance = json.loads((self.root / path).read_text())
        provenance['container']['image_id'] = 'changed-image'
        self.put(path, provenance)
        report = self.module.build_report(self.root)
        self.assertEqual(report['comparisons'][0]['behavior']['pair_n'], 0)
        self.assertIn('image_id', report['pair_exclusions'][0]['mismatched_fingerprint_fields'])

    def test_missing_opposite_duration_only_excludes_walltime_comparison(self):
        self.attempt(1, 'sol', 1)
        run = self.attempt(1, 'astra', 2)
        verdict = json.loads((self.root / run / 'verdict.json').read_text())
        verdict.pop('finished_at')
        self.put(f'{run}/verdict.json', verdict)
        report = self.module.build_report(self.root)
        self.assertEqual(report['comparisons'][0]['behavior']['pair_n'], 1)
        self.assertEqual(report['comparisons'][0]['subject_usd']['pair_n'], 1)
        self.assertEqual(report['comparisons'][0]['wall_seconds']['pair_n'], 0)

    def test_renderer_can_render_nonempty_and_missing_observations(self):
        self.attempt(1, 'sol', 1, 'fail')
        self.attempt(1, 'astra', 2)
        report = self.module.build_report(self.root)
        output = self.module.markdown(report)
        self.assertIsInstance(output, str)
        self.assertGreater(len(output), 100)
        self.assertNotIn('NaN', output)
        self.assertNotIn('Infinity', output)

    def test_wrong_grader_model_does_not_enter_comparison(self):
        manifest = json.loads((self.root / 'planned-manifest.json').read_text())
        manifest['grader_model'] = 'fixed-grader'
        self.put('planned-manifest.json', manifest)
        for arm in ['sol', 'astra']:
            run = self.attempt(1, arm, 1)
            verdict = json.loads((self.root / run / 'verdict.json').read_text())
            verdict['economics']['gauntlet']['model'] = 'fixed-grader' if arm == 'sol' else 'different-grader'
            self.put(f'{run}/verdict.json', verdict)
        report = self.module.build_report(self.root)
        self.assertEqual(report['comparisons'][0]['behavior']['pair_n'], 0)
        self.assertIn('grader_model_mismatch_or_absent', report['slots'][1]['issues'])

    def test_incomplete_delegate_capture_keeps_subtotal_but_excludes_workflow_cost(self):
        self.attempt(1, 'sol', 1)
        run = self.attempt(1, 'astra', 2)
        self.put(f'{run}/capture-coverage.json', dict(
                 schema='pri-3088.capture-coverage/v1', available_log_coverage_complete=False,
                 verdict='incomplete_capture', issues=['delegate_usage_missing']))
        report = self.module.build_report(self.root)
        row = report['comparisons'][0]
        self.assertEqual(row['behavior']['pair_n'], 1)
        self.assertEqual(row['wall_seconds']['pair_n'], 1)
        self.assertEqual(row['grader_usd']['pair_n'], 1)
        self.assertEqual(row['subject_usd']['pair_n'], 0)
        self.assertEqual(row['total_usd']['pair_n'], 0)
        self.assertEqual(report['accounting']['all_attempts']['subject_usd']['known_subtotal'], 3)
        self.assertEqual(report['accounting']['all_attempts']['subject_usd']['known_n'], 1)

    def test_missing_or_unknown_capture_audit_never_claims_complete_subject_cost(self):
        for coverage in [None, dict(schema='pri-3088.capture-coverage/v1',
                                   available_log_coverage_complete=None, verdict='unknown', issues=[]),
                         dict(schema='wrong-schema', available_log_coverage_complete=True,
                              verdict='complete_for_available_logs', issues=[])]:
            with self.subTest(coverage=coverage):
                self.temp.cleanup()
                self.setUp()
                run = self.attempt(1, 'sol', 5)
                target = self.root / run / 'capture-coverage.json'
                if coverage is None:
                    target.unlink()
                else:
                    self.put(f'{run}/capture-coverage.json', coverage)
                report = self.module.build_report(self.root)
                account = report['accounting']['all_attempts']['subject_usd']
                self.assertEqual(account['known_subtotal'], 5)
                self.assertEqual(account['known_n'], 0)
                self.assertFalse(report['attempts'][0]['capture_coverage']['validated_complete'])

    def correction_mode(self):
        state = json.loads((self.root / 'state.json').read_text())
        state['analysis'] = {'normalizer_correction_sha': 'reviewed-fix'}
        self.put('state.json', state)

    def corrected(self, original_dir, corrected_cost, run_id=None):
        run_id = run_id or Path(original_dir).name
        if not (self.root / original_dir / 'trajectory.json').exists():
            self.put(f'{original_dir}/trajectory.json', {'steps': [{'model_name': 'original-model'}]})
        self.put(f'corrected/{run_id}/trajectory.json', {'steps': [{'model_name': 'corrected-model'}]})
        self.put(f'corrected/{run_id}/repriced-coding.json',
                 dict(total_usd=corrected_cost, per_model=[], unpriced_models=[]))
        self.put(f'corrected/{run_id}/capture-coverage.json', dict(
                 schema='pri-3088.capture-coverage/v1', available_log_coverage_complete=True,
                 verdict='complete_for_available_logs', issues=[]))
        self.put(f'corrected/{run_id}/correction-receipt.json', dict(
                 normalizer_commit='reviewed-fix', run_id=run_id,
                 original_trajectory_sha256=hashlib.sha256((self.root / original_dir / 'trajectory.json').read_bytes()).hexdigest()))

    def test_correction_mode_uses_corrected_costs_and_preserves_original_amounts(self):
        sol = self.attempt(1, 'sol', 10)
        astra = self.attempt(1, 'astra', 20)
        self.corrected(sol, 8)
        self.corrected(astra, 15)
        self.correction_mode()
        report = self.module.build_report(self.root)
        row = report['comparisons'][0]
        self.assertEqual(row['subject_usd']['sol_median'], 8)
        self.assertEqual(row['subject_usd']['astra_median'], 15)
        self.assertEqual(report['accounting']['all_attempts']['subject_usd']['known_subtotal'], 23)
        first = next(a for a in report['attempts'] if a['arm'] == 'sol')
        self.assertEqual(first['original_repriced_subject_usd'], 10)
        self.assertEqual(first['corrected_subject_delta_usd'], -2)
        self.assertNotIn('original-model', first['observed_models'])

    def test_correction_mode_never_falls_back_when_corrected_artifacts_are_missing(self):
        self.attempt(1, 'sol', 10)
        self.attempt(1, 'astra', 20)
        self.correction_mode()
        report = self.module.build_report(self.root)
        self.assertEqual(report['comparisons'][0]['behavior']['pair_n'], 1)
        self.assertEqual(report['comparisons'][0]['wall_seconds']['pair_n'], 1)
        self.assertEqual(report['comparisons'][0]['subject_usd']['pair_n'], 0)
        self.assertEqual(report['accounting']['all_attempts']['subject_usd']['known_subtotal'], 0)
        self.assertTrue(all(a['subject_known_subtotal'] is None for a in report['attempts']))

    def test_wrong_correction_receipt_excludes_only_subject_and_total_cost(self):
        sol = self.attempt(1, 'sol', 10)
        astra = self.attempt(1, 'astra', 20)
        self.corrected(sol, 8)
        self.corrected(astra, 15)
        self.correction_mode()
        receipt_path = f'corrected/{Path(astra).name}/correction-receipt.json'
        receipt = json.loads((self.root / receipt_path).read_text())
        for field, bad_value in [('normalizer_commit', 'unreviewed'),
                                 ('original_trajectory_sha256', 'wrong-hash'),
                                 ('run_id', 'some-other-run'),
                                 ('corrected_repriced_sha256', 'tampered-hash')]:
            with self.subTest(field=field):
                self.put(receipt_path, {**receipt, field: bad_value})
                report = self.module.build_report(self.root)
                row = report['comparisons'][0]
                self.assertEqual(row['behavior']['pair_n'], 1)
                self.assertEqual(row['wall_seconds']['pair_n'], 1)
                self.assertEqual(row['grader_usd']['pair_n'], 1)
                self.assertEqual(row['subject_usd']['pair_n'], 0)
                self.assertEqual(report['accounting']['all_attempts']['subject_usd']['known_subtotal'], 8)

    def test_smoke_correction_uses_inventory_run_id_not_arm_directory(self):
        self.put('state.json', dict(measured_jobs=[], smoke_jobs=[
                 dict(model='model-astra', arm='astra', job_id='smoke-job', run_id='actual-smoke-run')]))
        self.put('smokes/astra/repriced-coding.json', dict(total_usd=99, per_model=[], unpriced_models=[]))
        self.corrected('smokes/astra', 90, run_id='actual-smoke-run')
        self.correction_mode()
        report = self.module.build_report(self.root)
        smoke = report['smokes']['collected_attempts'][0]
        self.assertEqual(smoke['run_id'], 'actual-smoke-run')
        self.assertEqual(smoke['subject_usd'], 90)
        self.assertEqual(report['accounting']['all_attempts']['subject_usd']['known_subtotal'], 0)


if __name__ == '__main__':
    unittest.main()
