"""Scores one E2EDev project with E2EDev's own Behave runner and metrics.

Runs inside the e2edev scorer image under xvfb-run. The benchmark checkout is
mounted read-only at /bench, the agent's workspace at /workspace, and results
are written to /out. run_behave_test.main() and Metrics/effectiveness.main()
are called unchanged; main() skips every project not present in the folder it
is given, so it runs exactly the one project copied there.
"""
import argparse
import importlib.util
import json
import os
import shutil
import sys

NOT_PROJECT = {'.git', 'node_modules', '__pycache__', '.venv', 'venv'}


def load(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--item', required=True, help='E2EDev project folder, e.g. E2ESD_Bench_01')
    parser.add_argument('--bench', default='/bench')
    parser.add_argument('--workspace', default='/workspace')
    parser.add_argument('--out', default='/out')
    args = parser.parse_args()

    projects = '/tmp/e2edev/projects'
    shutil.copytree(args.workspace, os.path.join(projects, args.item), ignore=shutil.ignore_patterns(*NOT_PROJECT))
    logs = os.path.join(args.out, 'behave_logs')
    results = os.path.join(args.out, 'behave_results')
    os.makedirs(logs, exist_ok=True)
    os.makedirs(results, exist_ok=True)

    runner = load(os.path.join(args.bench, 'run_behave_test.py'), 'run_behave_test')
    runner.main(projects, logs, results)

    result_file = os.path.join(results, f'{args.item}_behave.json')
    if os.path.exists(result_file):
        effectiveness = load(os.path.join(args.bench, 'Metrics/effectiveness.py'), 'effectiveness')
        req_accuracy, case_accuracy, final_score = effectiveness.main(results)
        with open(result_file, encoding='utf-8') as f:
            detail = json.load(f)
        requirements = len(detail)
        cases = sum(len(tests) for tests in detail.values())
        passed_cases = sum(1 for tests in detail.values() for r in tests.values() if r == 'pass')
        passed_requirements = sum(1 for tests in detail.values() if all(r == 'pass' for r in tests.values()))
    else:
        # The runner found no HTML file, so it ran no test: every requirement fails.
        with open(os.path.join(args.bench, 'E2EDev_data', args.item, 'requirment_with_tests.json'), encoding='utf-8') as f:
            tests = json.load(f)['finegrained_rewith_test']
        requirements = len(tests)
        cases = sum(len(value['test_cases']) for value in tests.values())
        passed_cases = passed_requirements = 0
        req_accuracy = case_accuracy = final_score = 0.0

    result = {
        'benchmark': 'e2edev',
        'item': args.item,
        'metrics': {
            'requirements': requirements,
            'passedRequirements': passed_requirements,
            'cases': cases,
            'passedCases': passed_cases,
            'reqAccuracy': req_accuracy,
            'caseAccuracy': case_accuracy,
            'finalScore': final_score,
        },
    }
    with open(os.path.join(args.out, 'score.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
