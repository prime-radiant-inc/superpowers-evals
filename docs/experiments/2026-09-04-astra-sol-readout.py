#!/usr/bin/env python3
"""Reproduce the PRI-3088 Astra-versus-Sol exploratory readout offline.

Requires only Python's standard library. The input directory contains the
planned manifest, job inventory, and collected original/corrected artifacts.
No evals are launched and no model pricing or token parsing is performed.

Usage:
    python3 docs/experiments/2026-09-04-astra-sol-readout.py \
        --data-root /path/to/pri-3088 --output-dir /path/to/readout
"""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
from statistics import median


ARMS = ('sol', 'astra')
OUTCOMES = ('pass', 'fail', 'indeterminate')
QUANTITIES = ('subject_usd', 'grader_usd', 'total_usd', 'wall_seconds')


def number(value):
    return value if type(value) in (float, int) and math.isfinite(value) and value >= 0 else None


def strings(values):
    return sorted({v for v in values if isinstance(v, str) and v})


def stamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (ValueError, TypeError, AttributeError):
        return None


def elapsed(start, finish):
    first, last = stamp(start), stamp(finish)
    return number(last - first) if first is not None and last is not None else None


class Inputs:
    def __init__(self, root):
        self.root = root
        self.receipts = {}
        self.warnings = []

    def read(self, path, lines=False):
        relative = str(path.relative_to(self.root))
        try:
            raw = path.read_bytes()
        except OSError:
            self.receipts[relative] = {'status': 'missing_or_unreadable'}
            return [] if lines else {}
        self.receipts[relative] = {'status': 'read', 'sha256': hashlib.sha256(raw).hexdigest()}
        try:
            value = [json.loads(line) for line in raw.splitlines() if line.strip()] if lines else json.loads(raw)
            if (lines and not all(isinstance(row, dict) for row in value)) or (not lines and not isinstance(value, dict)):
                raise ValueError('expected object')
            return value
        except (ValueError, UnicodeError):
            self.receipts[relative]['status'] = 'invalid'
            self.warnings.append(f'Invalid collected JSON: {relative}')
            return [] if lines else {}


def read_attempt(inputs, directory, attempt_id, job=None, result=None, correction_sha=None):
    job, result = job or {}, result or {}
    run_id = job.get('run_id') if attempt_id.startswith('smoke:') else directory.name
    verdict = inputs.read(directory / 'verdict.json')
    repriced = inputs.read(directory / 'repriced-coding.json')
    original_subject_subtotal = number(repriced.get('total_usd'))
    usage = inputs.read(directory / 'coding-agent-token-usage.json')
    observed = inputs.read(directory / 'observed-config.json')
    coverage = inputs.read(directory / 'capture-coverage.json')
    trajectory = inputs.read(directory / 'trajectory.json')
    correction_issues = []
    corrected_directory = None
    receipt = {}
    if correction_sha is not None:
        if not isinstance(run_id, str) or not run_id or Path(run_id).name != run_id:
            correction_issues.append('correction_run_identity_missing_or_invalid')
            repriced, coverage, trajectory = {}, {}, {}
        else:
            corrected_directory = inputs.root / 'corrected' / run_id
            repriced = inputs.read(corrected_directory / 'repriced-coding.json')
            coverage = inputs.read(corrected_directory / 'capture-coverage.json')
            trajectory = inputs.read(corrected_directory / 'trajectory.json')
            receipt = inputs.read(corrected_directory / 'correction-receipt.json')
            if receipt.get('normalizer_commit') != correction_sha:
                correction_issues.append('correction_normalizer_commit_mismatch_or_absent')
            if receipt.get('run_id') != run_id:
                correction_issues.append('correction_receipt_run_id_mismatch_or_absent')
            hash_inputs = {
                'original_trajectory_sha256': directory / 'trajectory.json',
                'original_repriced_sha256': directory / 'repriced-coding.json',
                'corrected_trajectory_sha256': corrected_directory / 'trajectory.json',
                'corrected_repriced_sha256': corrected_directory / 'repriced-coding.json',
                'pricing_snapshot_sha256': inputs.root / 'pricing' / 'current.json',
            }
            if 'pricing_snapshot_sha256' in receipt:
                inputs.read(hash_inputs['pricing_snapshot_sha256'])
            for key, path in hash_inputs.items():
                if key != 'original_trajectory_sha256' and key not in receipt:
                    continue
                actual_hash = inputs.receipts.get(str(path.relative_to(inputs.root)), {}).get('sha256')
                if not actual_hash or receipt.get(key) != actual_hash:
                    correction_issues.append(f'correction_{key}_mismatch_or_absent')
            for name, value in [('trajectory', trajectory), ('repriced_coding', repriced), ('capture_coverage', coverage)]:
                if not value:
                    correction_issues.append(f'corrected_{name}_missing_or_invalid')
            if trajectory and not isinstance(trajectory.get('steps'), list):
                correction_issues.append('corrected_trajectory_steps_invalid')
        if correction_issues:
            # Wrongly bound or unavailable derived artifacts supply no selected
            # subject amount. Originals remain visible solely as historical data.
            repriced, coverage, trajectory = {}, {}, {}
    economics = verdict.get('economics') or {}
    grader = economics.get('gauntlet') or {}
    native_subject = economics.get('coding_agent') or {}
    steps = trajectory.get('steps') or []
    models = strings([observed.get('model'), usage.get('model')] +
                     (observed.get('observed_models') or []) +
                     [s.get('model_name') for s in steps if isinstance(s, dict)] +
                     [p.get('model') for p in (repriced.get('per_model') or []) if isinstance(p, dict)])
    subject_subtotal = number(repriced.get('total_usd'))
    # Repricing is the sole selected subject-cost source. A native estimate is
    # retained separately, never silently substituted for missing repricing.
    coverage_complete = (coverage.get('schema') == 'pri-3088.capture-coverage/v1'
                         and coverage.get('available_log_coverage_complete') is True
                         and coverage.get('verdict') == 'complete_for_available_logs')
    subject_complete = (subject_subtotal is not None and repriced.get('unpriced_models') == []
                        and coverage_complete)
    grader_subtotal = number(grader.get('est_cost_usd'))
    grader_complete = (grader_subtotal is not None and grader.get('has_unpriced_model') is False)
    subject = subject_subtotal if subject_complete else None
    grader_cost = grader_subtotal if grader_complete else None
    wall = elapsed(verdict.get('started_at'), verdict.get('finished_at'))
    post = [c for c in (verdict.get('checks') or []) if isinstance(c, dict) and c.get('phase') == 'post']
    check_status = ('pass' if all(c.get('passed') is True for c in post) else 'fail') if post and all(type(c.get('passed')) is bool for c in post) else None
    gauntlet = verdict.get('gauntlet') or {}
    judge_status = gauntlet.get('status') if gauntlet.get('status') in OUTCOMES else None
    disagreement = (judge_status != check_status) if judge_status in ('pass', 'fail') and check_status is not None else None
    issues = []
    for field in ('scenario', 'credential', 'coding_agent'):
        if result.get(field) is not None and verdict.get(field) is not None and result[field] != verdict[field]:
            issues.append(f'result_verdict_{field}_mismatch')
    if not verdict:
        issues.append('verdict_missing_or_invalid')
    if not observed.get('model'):
        issues.append('root_model_unobserved')
    if not observed.get('reasoning_effort'):
        issues.append('root_effort_unobserved')
    return {
        'attempt_id': attempt_id, 'job_id': job.get('job_id'), 'batch_id': job.get('batch_id'),
        'arm': job.get('arm'), 'replicate': job.get('replicate'),
        'run_id': run_id, 'scenario': result.get('scenario') or verdict.get('scenario'),
        'credential': verdict.get('credential') or result.get('credential'),
        'coding_agent': verdict.get('coding_agent') or result.get('coding_agent'),
        'outcome': verdict.get('final') if verdict.get('final') in OUTCOMES else 'unobserved',
        'gauntlet_status': judge_status, 'post_checks_status': check_status,
        'post_check_n': len(post), 'failed_post_checks': [c.get('check') for c in post if c.get('passed') is False],
        'vacuous_post_check_n': sum('vacuous' in str(c.get('detail', '')).lower() for c in post),
        'disagreement': disagreement, 'root_model': observed.get('model'),
        'root_effort': observed.get('reasoning_effort'), 'observed_models': models,
        'observed_efforts': strings(observed.get('observed_efforts') or [observed.get('reasoning_effort')]),
        'grader_model': grader.get('model'),
        'subject_usd': subject, 'grader_usd': grader_cost,
        'total_usd': subject + grader_cost if subject is not None and grader_cost is not None else None,
        'subject_known_subtotal': subject_subtotal, 'grader_known_subtotal': grader_subtotal,
        'subject_cost_source': 'corrected_obol' if correction_sha is not None else 'original_obol',
        'original_repriced_subject_usd': original_subject_subtotal,
        'corrected_subject_delta_usd': subject_subtotal - original_subject_subtotal
        if correction_sha is not None and subject_subtotal is not None and original_subject_subtotal is not None else None,
        'normalizer_correction': {
            'enabled': correction_sha is not None, 'expected_commit': correction_sha,
            'receipt_commit': receipt.get('normalizer_commit'),
            'validated': not correction_issues if correction_sha is not None else None,
            'issues': correction_issues,
            'artifact_directory': str(corrected_directory.relative_to(inputs.root)) if corrected_directory else None,
        },
        'wall_seconds': wall, 'started_at': verdict.get('started_at'), 'finished_at': verdict.get('finished_at'),
        'subject_session_span_seconds': number(usage.get('duration_ms')) / 1000 if number(usage.get('duration_ms')) is not None else None,
        'native_subject_usd': number(native_subject.get('est_cost_usd')),
        'native_total_usd': number(economics.get('total_est_cost_usd')),
        'native_economics_partial': economics.get('partial'),
        'capture_coverage': {
            'validated_complete': coverage_complete,
            'available_log_coverage_complete': coverage.get('available_log_coverage_complete')
            if type(coverage.get('available_log_coverage_complete')) is bool else None,
            'verdict': coverage.get('verdict') if coverage.get('schema') == 'pri-3088.capture-coverage/v1' else 'missing_or_invalid',
            'issues': strings(coverage.get('issues') or []),
        },
        'pricing_as_of': repriced.get('pricing_as_of'),
        'unpriced_subject_models': strings(repriced.get('unpriced_models') or []),
        'pricing_approximations': strings([a.get('kind') for a in (repriced.get('approximations') or []) if isinstance(a, dict)]),
        'provenance': {k: (verdict.get('provenance') or {}).get(k) for k in
                       ('superpowers_rev', 'harness_rev', 'agent_cli_version', 'gauntlet_version', 'host_platform')},
        'issues': issues, 'artifact_directory': str(directory.relative_to(inputs.root)),
    }


def totals(attempts):
    result = {'attempt_n': len(attempts)}
    for quantity in QUANTITIES:
        known = [a[quantity] for a in attempts if a.get(quantity) is not None]
        if quantity == 'subject_usd':
            subtotal = sum(a.get('subject_known_subtotal') or 0 for a in attempts)
        elif quantity == 'grader_usd':
            subtotal = sum(a.get('grader_known_subtotal') or 0 for a in attempts)
        elif quantity == 'total_usd':
            subtotal = sum((a.get('subject_known_subtotal') or 0) + (a.get('grader_known_subtotal') or 0) for a in attempts)
        else:
            subtotal = sum(known)
        result[quantity] = {'known_subtotal': subtotal, 'known_n': len(known),
                            'expected_n': len(attempts), 'missing_or_partial_n': len(attempts) - len(known),
                            'complete_for_observed_attempts': bool(attempts) and len(known) == len(attempts)}
    return result


def paired_metric(pairs, quantity):
    complete = [(key, s, a) for key, s, a in pairs if s.get(quantity) is not None and a.get(quantity) is not None]
    return {'pair_n': len(complete), 'pair_ids': [p[0] for p in complete],
            'sol_median': median([s[quantity] for _, s, _ in complete]) if complete else None,
            'astra_median': median([a[quantity] for _, _, a in complete]) if complete else None,
            'median_paired_delta': median([a[quantity] - s[quantity] for _, s, a in complete]) if complete else None}


def build_report(root):
    root = Path(root)
    inputs = Inputs(root)
    manifest, state = inputs.read(root / 'planned-manifest.json'), inputs.read(root / 'state.json')
    analysis = state.get('analysis') or {}
    correction_sha = analysis.get('normalizer_correction_sha')
    if 'normalizer_correction_sha' in analysis and (not isinstance(correction_sha, str) or not correction_sha):
        raise ValueError('analysis.normalizer_correction_sha must be a nonempty commit string')
    planned = manifest.get('slots')
    if not isinstance(planned, list) or not planned:
        raise ValueError('A valid nonempty planned-manifest.json slots list is required')
    keys = [(s['pair_id'], s['arm']) for s in planned]
    if len(set(keys)) != len(keys):
        raise ValueError('Duplicate planned pair_id/arm slot')
    jobs = state.get('measured_jobs') or []
    if len({j['job_id'] for j in jobs}) != len(jobs):
        raise ValueError('Duplicate measured job_id in state inventory')
    inventory = {j['job_id']: j for j in jobs}
    measured = root / 'measured'
    collected_dirs = {d.name: d for d in measured.iterdir() if d.is_dir()} if measured.is_dir() else {}
    attempts, job_rows, seen_runs = [], [], set()
    for job_id in sorted(set(inventory) | set(collected_dirs)):
        job = inventory.get(job_id, {'job_id': job_id})
        if job_id not in inventory:
            inputs.warnings.append(f'Collected job absent from state inventory: {job_id}; accounting only')
        directory = measured / job_id
        header = inputs.read(directory / 'batch.json')
        results = inputs.read(directory / 'results.jsonl', lines=True)
        inputs.read(directory / 'native-costs.json')
        provenance = inputs.read(directory / 'provenance.json')
        refs = provenance.get('refs') or {}
        fingerprint = {
            'evals_sha': refs.get('evals_resolved_sha'),
            'superpowers_sha': refs.get('superpowers_resolved_sha'),
            'gauntlet_sha': refs.get('gauntlet_built_sha'),
            'bundle_id': (provenance.get('credential_bundle') or {}).get('bundle_id'),
            'image_id': (provenance.get('container') or {}).get('image_id'),
            'tool_versions_sha256': hashlib.sha256(provenance['tool_versions_text'].encode()).hexdigest()
            if isinstance(provenance.get('tool_versions_text'), str) else None,
        }
        mismatch = bool(header and job.get('batch_id') and header.get('id') != job['batch_id'])
        if mismatch:
            inputs.warnings.append(f'Batch identity mismatch: {job_id}; comparison excluded')
        records_by_run = defaultdict(list)
        for result in results:
            if result.get('run_id'):
                records_by_run[result['run_id']].append(result)
        run_root = directory / 'runs'
        run_dirs = {p.name: p for p in run_root.iterdir() if p.is_dir()} if run_root.is_dir() else {}
        for run_id in sorted(set(records_by_run) | set(run_dirs)):
            if Path(run_id).name != run_id:
                raise ValueError('Run id must be a directory basename')
            if run_id in seen_runs:
                raise ValueError('A run id occurs in multiple measured jobs; cannot attribute costs safely')
            seen_runs.add(run_id)
            records = records_by_run.get(run_id, [])
            attempt = read_attempt(inputs, run_root / run_id, run_id, job, records[0] if records else {}, correction_sha)
            if len(records) > 1 and any(r != records[0] for r in records[1:]):
                attempt['issues'].append('conflicting_result_records')
            if mismatch:
                attempt['issues'].append('batch_identity_mismatch')
            attempt['execution_fingerprint'] = fingerprint
            if manifest.get('evals_sha'):
                for key, value in fingerprint.items():
                    if value is None:
                        attempt['issues'].append(f'job_{key}_unobserved')
                for key in ('evals_sha', 'superpowers_sha', 'gauntlet_sha'):
                    if manifest.get(key) and fingerprint[key] != manifest[key]:
                        attempt['issues'].append(f'job_{key}_mismatch')
            attempts.append(attempt)
        job_rows.append({**{k: job.get(k) for k in ('job_id', 'batch_id', 'arm', 'replicate')},
                         'collected': directory.is_dir(), 'batch_started_at': header.get('started_at'),
                         'batch_finished_at': header.get('finished_at'), 'result_record_n': len(results),
                         'unresolved_launch_record_n': sum(not r.get('run_id') and not r.get('skipped') for r in results),
                         'skipped_scenarios': [r.get('scenario') for r in results if r.get('skipped')],
                         'provenance_fields_present': sorted(provenance),
                         'execution_fingerprint': fingerprint,
                         'batch_identity_mismatch': mismatch})

    slots = []
    for planned_slot in planned:
        slot = {k: planned_slot[k] for k in ('pair_id', 'scenario', 'replicate', 'arm', 'model', 'credential')}
        associated = [a for a in attempts if a['arm'] == slot['arm'] and a['replicate'] == slot['replicate'] and a['scenario'] == slot['scenario']]
        slot.update(outcome='unobserved', comparison_eligible=False, disagreement=None,
                    attempt_ids=[a['attempt_id'] for a in associated], selected_attempt_id=None,
                    issues=[], gauntlet_status=None, post_checks_status=None)
        matching_jobs = [j for j in job_rows if j['arm'] == slot['arm'] and j['replicate'] == slot['replicate']]
        if not associated:
            if not matching_jobs:
                status = 'not_in_job_inventory'
            elif not any(j['collected'] for j in matching_jobs):
                status = 'job_uncollected'
            elif any(slot['scenario'] in j['skipped_scenarios'] for j in matching_jobs):
                status = 'batch_recorded_skip'
            else:
                status = 'no_run_evidence_collected'
            slot['observation_status'] = status
        elif len(associated) > 1:
            slot['observation_status'] = 'ambiguous_attempts'
            slot['issues'].append('No automatic winner selection across repeated attempts')
        else:
            attempt = associated[0]
            issues = list(attempt['issues'])
            for key in ('credential',):
                if attempt.get(key) != slot[key]:
                    issues.append(f'{key}_mismatch_or_absent')
            if attempt.get('coding_agent') != manifest.get('agent', 'codex'):
                issues.append('coding_agent_mismatch_or_absent')
            if attempt['root_model'] != slot['model']:
                issues.append('root_model_mismatch_or_absent')
            if attempt['root_effort'] != manifest.get('reasoning_effort'):
                issues.append('root_effort_mismatch_or_absent')
            if manifest.get('grader_model') and attempt['grader_model'] != manifest['grader_model']:
                issues.append('grader_model_mismatch_or_absent')
            for observed_key, planned_key in [('superpowers_rev', 'superpowers_sha'), ('harness_rev', 'evals_sha')]:
                if manifest.get(planned_key) and attempt['provenance'].get(observed_key) != manifest[planned_key]:
                    issues.append(f'{observed_key}_mismatch_or_absent')
            slot.update(outcome=attempt['outcome'], selected_attempt_id=attempt['attempt_id'],
                        observation_status='observed_terminal' if attempt['outcome'] in OUTCOMES else 'verdict_missing_or_invalid',
                        comparison_eligible=not issues and attempt['outcome'] in ('pass', 'fail'),
                        issues=sorted(set(issues)), disagreement=attempt['disagreement'],
                        gauntlet_status=attempt['gauntlet_status'], post_checks_status=attempt['post_checks_status'])
        slots.append(slot)

    by_id = {a['attempt_id']: a for a in attempts}
    pairs_by_scenario = defaultdict(list)
    pair_exclusions = []
    comparable_ids = set()
    for pair_id in dict.fromkeys(s['pair_id'] for s in slots):
        pair = {s['arm']: s for s in slots if s['pair_id'] == pair_id}
        if set(pair) != set(ARMS):
            raise ValueError('Every planned pair must have exactly sol and astra')
        if pair['sol']['scenario'] != pair['astra']['scenario']:
            raise ValueError('A pair cannot span different scenarios')
        if all(s['comparison_eligible'] for s in pair.values()):
            sol, astra = (by_id[pair[arm]['selected_attempt_id']] for arm in ARMS)
            mismatches = [key for key in sol['execution_fingerprint']
                          if sol['execution_fingerprint'][key] != astra['execution_fingerprint'][key]]
            if mismatches:
                pair_exclusions.append({'pair_id': pair_id, 'reason': 'execution_fingerprint_mismatch',
                                        'mismatched_fingerprint_fields': mismatches})
                continue
            pairs_by_scenario[pair['sol']['scenario']].append((pair_id, sol, astra))
            comparable_ids.update((sol['attempt_id'], astra['attempt_id']))
    comparisons, arm_rows = [], []
    for scenario in dict.fromkeys(s['scenario'] for s in planned):
        pairs = pairs_by_scenario[scenario]
        sol_pass = sum(s['outcome'] == 'pass' for _, s, _ in pairs)
        astra_pass = sum(a['outcome'] == 'pass' for _, _, a in pairs)
        comparisons.append({'scenario': scenario,
                            'behavior': {'pair_n': len(pairs), 'pair_ids': [p[0] for p in pairs],
                                         'sol_pass': sol_pass, 'astra_pass': astra_pass,
                                         'delta_astra_minus_sol': (astra_pass - sol_pass) / len(pairs) if pairs else None},
                            **{q: paired_metric(pairs, q) for q in QUANTITIES}})
        for arm in ARMS:
            selected = [s for s in slots if s['scenario'] == scenario and s['arm'] == arm]
            counts = {k: sum(s['outcome'] == k for s in selected) for k in (*OUTCOMES, 'unobserved')}
            n = len(selected)
            arm_rows.append({'scenario': scenario, 'arm': arm, 'planned_n': n, **counts,
                             'determinate_rate': counts['pass'] / (counts['pass'] + counts['fail']) if counts['pass'] + counts['fail'] else None,
                             'observed_terminal_share': (n - counts['unobserved']) / n if n else None,
                             'disagreement_n': sum(s['disagreement'] is True for s in selected),
                             'judgment_comparison_n': sum(s['disagreement'] is not None for s in selected),
                             'comparison_ineligible_n': sum(not s['comparison_eligible'] for s in selected),
                             'observation_status_counts': dict(Counter(s['observation_status'] for s in selected)),
                             'all_attempt_accounting': totals([a for a in attempts if a['scenario'] == scenario and a['arm'] == arm])})
    smoke_attempts = []
    for arm in ARMS:
        directory = root / 'smokes' / arm
        if directory.is_dir():
            arm_models = {s['model'] for s in planned if s['arm'] == arm}
            smoke_jobs = [j for j in (state.get('smoke_jobs') or []) if j.get('arm') == arm or j.get('model') in arm_models]
            if len(smoke_jobs) != 1:
                inputs.warnings.append(f'Smoke {arm} has no unique inventory identity; corrected costs unavailable')
            smoke_job = {**(smoke_jobs[0] if len(smoke_jobs) == 1 else {}), 'arm': arm}
            smoke_attempts.append(read_attempt(inputs, directory, f'smoke:{arm}', smoke_job, correction_sha=correction_sha))
    known_batch_starts = [stamp(j['batch_started_at']) for j in job_rows if stamp(j['batch_started_at']) is not None]
    known_batch_finishes = [stamp(j['batch_finished_at']) for j in job_rows if stamp(j['batch_finished_at']) is not None]
    envelope = max(known_batch_finishes) - min(known_batch_starts) if known_batch_starts and known_batch_finishes else None
    return {'schema': 'pri-3088-offline-readout/v1', 'experiment': manifest.get('experiment'),
            'subject_cost_mode': 'corrected_obol' if correction_sha is not None else 'original_obol',
            'normalizer_correction_sha': correction_sha,
            'generated_at': datetime.now(timezone.utc).isoformat(), 'planned_slot_n': len(slots),
            'observed_terminal_slot_n': sum(s['outcome'] in OUTCOMES for s in slots),
            'study_complete': all(s['outcome'] in OUTCOMES for s in slots),
            'assumptions': [
                'Exploratory; replicate-matched separate arm batches are not contemporaneous randomized pairs.',
                'Manifest primary slots remain fixed; missing collection is not proof that work never started.',
                'Comparative metrics require determinate outcomes and matching observed root model/effort/provenance on both arms.',
                'Each cost/time comparison independently requires the same complete observations on both arms; no cost imputation.',
                'Subject cost uses collected obol repricing only; grader cost uses frozen verdict economics. These are standardized token-cost estimates, not complete bills; separately billed tool fees are not included.',
                'When the study correction switch is enabled, only corrected subject repricing/audit/trajectory with a matching correction receipt are selected. Missing or invalid corrections never fall back to originals; original amounts and correction deltas are separately labeled.',
                'All-attempt accounting includes noncomparable work; unknown or partial costs remain explicit.',
                'Wall time is verdict finished_at minus started_at. Summed worker seconds are occupancy, not study latency.',
                'Captured coding duration is a session-log timestamp span, not active compute time. Grader session duration overlaps subject execution and is not added or subtracted.',
                'Subject and total workflow-cost comparisons require capture-coverage.json to validate coverage of available logs and repricing to have no unpriced models. Missing/incomplete audit retains captured known spend but excludes those cost comparisons only.',
                'Capture audits establish coverage of available logs, not proof that every provider call produced an available log. Observed model mix is capture-visible only.',
                'Job source SHAs, image, tool-version fingerprint and credential-bundle identity must agree across compared arms; container IDs and job mount paths are intentionally ignored.',
                'Repeated attempts are never auto-selected; slot remains ambiguous while all their costs stay visible.',
                'Smoke artifacts are excluded from measured slots, comparisons, and measured cost totals.',
                'No raw transcript, prompt, grader reasoning, credential contents, or tool arguments are emitted.',
            ], 'slots': slots, 'attempts': attempts, 'arm_rows': arm_rows, 'comparisons': comparisons,
            'pair_exclusions': pair_exclusions,
            'accounting': {'all_attempts': totals(attempts),
                           'by_arm': {arm: totals([a for a in attempts if a['arm'] == arm]) for arm in ARMS},
                           'noncomparable_attempt_n': sum(a['attempt_id'] not in comparable_ids for a in attempts),
                           'noncomparable_attempts': totals([a for a in attempts if a['attempt_id'] not in comparable_ids]),
                           'unresolved_launch_record_n': sum(j['unresolved_launch_record_n'] for j in job_rows)},
            'observed_model_mix': {arm: strings([m for a in attempts if a['arm'] == arm for m in a['observed_models']]) for arm in ARMS},
            'observed_grader_models': strings([a['grader_model'] for a in attempts]),
            'smokes': {'excluded_from_measurement': True, 'collected_attempts': smoke_attempts,
                       'inventory_job_n': len(state.get('smoke_jobs') or []), 'accounting': totals(smoke_attempts)},
            'jobs': job_rows, 'collected_batch_time_envelope_seconds': envelope,
            'time_envelope_caveat': 'Earliest collected batch start to latest collected batch finish; incomplete batches or absent jobs prevent a complete study duration.',
            'warnings': inputs.warnings, 'input_receipts': inputs.receipts}


def fmt(value):
    return '—' if value is None else f'{value:.4f}'.rstrip('0').rstrip('.')


def cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' ').replace('<', '&lt;').replace('>', '&gt;')


def markdown(report, data_root=Path('..')):
    lines = ['# PRI-3088 Astra vs Sol — exploratory readout', '',
             f"Observed terminal slots: **{report['observed_terminal_slot_n']}/{report['planned_slot_n']}**. "
             f"Collected measured attempts: **{len(report['attempts'])}**. Smokes excluded.", '',
             f"Selected subject-cost mode: **{report['subject_cost_mode']}**. Correction commit: {report['normalizer_correction_sha'] or 'none'}.", '',
             '## Scope and assumptions', ''] + [f'- {s}' for s in report['assumptions']]
    lines += ['', '## Per-scenario outcomes', '',
              '| Scenario | Arm | Planned | Pass | Fail | Indeterminate | Unobserved | Judge/check disagreements |',
              '|---|---|---:|---:|---:|---:|---:|---:|']
    for row in report['arm_rows']:
        lines.append('| ' + ' | '.join(cell(row[k]) for k in ('scenario', 'arm', 'planned_n', 'pass', 'fail', 'indeterminate', 'unobserved')) +
                     f" | {row['disagreement_n']}/{row['judgment_comparison_n']} |")
    lines += ['', '## Matched comparisons', '', 'Deltas are Astra minus Sol. Costs are USD; wall times are seconds. All metrics here condition on both outcomes being determinate and provenance being observed.', '',
              '| Scenario | Quantity | Complete pairs | Sol | Astra | Delta |', '|---|---|---:|---:|---:|---:|']
    for row in report['comparisons']:
        b = row['behavior']
        lines.append(f"| {cell(row['scenario'])} | Pass share | {b['pair_n']} | {b['sol_pass']}/{b['pair_n']} | {b['astra_pass']}/{b['pair_n']} | {fmt(b['delta_astra_minus_sol'])} |")
        for quantity in QUANTITIES:
            q = row[quantity]
            lines.append(f"| {cell(row['scenario'])} | {quantity}: median | {q['pair_n']} | {fmt(q['sol_median'])} | {fmt(q['astra_median'])} | {fmt(q['median_paired_delta'])} |")
    lines += ['', 'Delta for continuous quantities is the median of pairwise deltas, which need not equal the difference between the two medians.', '',
              '## All-attempt accounting', '', 'Known subtotals include available partial amounts. Coverage counts fully known observations over collected run identities; unresolved launches and uncollected work can add further unknown spend.', '',
              '| Scope | Attempts | Subject USD / coverage | Grader USD / coverage | All USD / coverage | Worker seconds / coverage |',
              '|---|---:|---|---|---|---|']
    scopes = [('Measured: all', report['accounting']['all_attempts'])] + list(report['accounting']['by_arm'].items()) + [
        ('Noncomparable measured work', report['accounting']['noncomparable_attempts']), ('Smokes: excluded', report['smokes']['accounting'])]
    for name, account in scopes:
        values = [f"{fmt(account[q]['known_subtotal'])} / {account[q]['known_n']}/{account[q]['expected_n']}" for q in QUANTITIES]
        lines.append(f"| {name} | {account['attempt_n']} | " + ' | '.join(values) + ' |')
    lines += ['', f"Unresolved launch records: {report['accounting']['unresolved_launch_record_n']}.",
              f"Collected batch time envelope: {fmt(report['collected_batch_time_envelope_seconds'])} seconds. {report['time_envelope_caveat']}", '',
              '## Observed model mix', '']
    lines += [f"- {arm}: {', '.join(report['observed_model_mix'][arm]) or 'unobserved'}" for arm in ARMS]
    lines += ['', '## Every planned slot', '', '| Pair | Arm | Outcome | Observation | Attempt | Issues |', '|---|---|---|---|---|---|']
    for s in report['slots']:
        lines.append('| ' + ' | '.join(cell(v) for v in [s['pair_id'], s['arm'], s['outcome'], s['observation_status'], s['selected_attempt_id'] or '—', ', '.join(s['issues'])]) + ' |')
    lines += ['', '## Capture coverage', '',
              '| Attempt | Available-log audit | Subject workflow cost complete | Issues |', '|---|---|---|---|']
    for a in report['attempts'] + report['smokes']['collected_attempts']:
        audit = a['capture_coverage']
        lines.append('| ' + ' | '.join(cell(v) for v in [a['attempt_id'], audit['verdict'],
                     a['subject_usd'] is not None, ', '.join(audit['issues'])]) + ' |')
    if report['normalizer_correction_sha']:
        lines += ['', '## Corrected subject estimates', '',
                  'Only validated corrected amounts enter selected-cost accounting. Original amounts below are historical, not fallback costs.', '',
                  '| Attempt | Original USD | Selected corrected subtotal USD | Corrected minus original USD | Correction issues |',
                  '|---|---:|---:|---:|---|']
        for a in report['attempts'] + report['smokes']['collected_attempts']:
            lines.append('| ' + ' | '.join(cell(v) for v in [a['attempt_id'], fmt(a['original_repriced_subject_usd']),
                         fmt(a['subject_known_subtotal']), fmt(a['corrected_subject_delta_usd']),
                         ', '.join(a['normalizer_correction']['issues'])]) + ' |')
    lines += ['', '## Artifact evidence', '']
    for a in report['attempts']:
        path = data_root / a['artifact_directory'] / 'verdict.json'
        lines.append(f"- [{cell(a['attempt_id'])}]({path}): root model {cell(a['root_model'])}, effort {cell(a['root_effort'])}; vacuous post-checks {a['vacuous_post_check_n']}.")
    if report['pair_exclusions']:
        lines += ['', '## Excluded comparisons', '']
        lines += [f"- {cell(p['pair_id'])}: {cell(p['reason'])}; {', '.join(p['mismatched_fingerprint_fields'])}." for p in report['pair_exclusions']]
    if report['warnings']:
        lines += ['', '## Collection warnings', ''] + [f'- {cell(w)}' for w in report['warnings']]
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--data-root', type=Path, required=True, help='Collected PRI-3088 artifact directory')
    parser.add_argument('--output-dir', type=Path, required=True, help='Destination for summary.json and summary.md')
    args = parser.parse_args()
    data_root, output_dir = args.data_root.resolve(), args.output_dir.resolve()
    report = build_report(data_root)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'summary.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
    (output_dir / 'summary.md').write_text(markdown(report, data_root))
    print(f"Readout: {report['observed_terminal_slot_n']}/{report['planned_slot_n']} terminal slots; {len(report['attempts'])} measured attempts. Wrote {output_dir / 'summary.md'}")
