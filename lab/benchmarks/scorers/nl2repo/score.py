"""Scores one NL2Repo-Bench task with NL2Repo-Bench's own post-processing.

Runs inside the nl2repo scorer image, which talks to the Docker daemon
through the mounted socket. The benchmark checkout is mounted read-only at
/bench, the agent's workspace at /workspace, and results are written to /out.
post_process_task() is called unchanged: it removes packaging and test files
from a copy of the workspace, builds it onto the task's published test image
and runs the task's test commands there.
"""
import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import uuid

NOT_PROJECT = {'.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache'}
IMAGE = 'ghcr.io/multimodal-art-projection/nl2repobench/{}:1.0'


def registry_digest(image: str) -> list:
    """The test image's manifest digest; BuildKit pulls it without adding it to the local image list."""
    inspect = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', image], capture_output=True, text=True)
    return [f'{image.rsplit(":", 1)[0]}@{line.split()[1]}' for line in inspect.stdout.splitlines() if line.startswith('Digest:')]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--item', required=True, help='NL2Repo-Bench task name, e.g. aiofiles')
    parser.add_argument('--bench', default='/bench')
    parser.add_argument('--workspace', default='/workspace')
    parser.add_argument('--out', default='/out')
    args = parser.parse_args()

    work = '/tmp/nl2repo'
    shutil.copytree(args.bench, work, ignore=shutil.ignore_patterns('.git', 'workspaces'))
    os.chdir(work)
    sys.path.insert(0, work)

    import test_data_service
    from openhands.post_processor import post_process_task
    from python_on_whales import DockerClient

    test_data_service.read_all_test_data()
    test_data = next(d for d in test_data_service.test_data_list if d.proName == args.item)

    # Docker image names must be lowercase.
    task_uuid = f'lab-{uuid.uuid4().hex[:12]}'
    workspace = os.path.join(work, 'workspaces', task_uuid, 'workspace')
    shutil.copytree(args.workspace, workspace, ignore=shutil.ignore_patterns(*NOT_PROJECT))

    logger = logging.getLogger('nl2repo-scorer')
    logging.basicConfig(level=logging.INFO)
    outcome = post_process_task(task_uuid, workspace, test_data, logger)

    docker = DockerClient()
    image = IMAGE.format(args.item)
    digests = registry_digest(image)
    if outcome.get('test_image_tag'):
        docker.image.remove(outcome['test_image_tag'], force=True)

    os.makedirs(args.out, exist_ok=True)
    shutil.copy2(os.path.join(work, 'workspaces', task_uuid, 'log.log'), os.path.join(args.out, 'post-process.log'))
    pytest = outcome.get('pytest_results') or {'passed': 0, 'failed': 0, 'errors': 0, 'total': test_data.testCaseCount, 'success_rate': 0.0}
    result = {
        'benchmark': 'nl2repo',
        'item': args.item,
        'testImage': {'name': image, 'repoDigests': digests},
        'status': outcome['status'],
        'metrics': {
            'passed': pytest['passed'],
            'failed': pytest['failed'],
            'errors': pytest['errors'],
            'cases': pytest['total'],
            'passRate': pytest['success_rate'],
        },
    }
    if outcome['status'] != 'success':
        result['error'] = outcome.get('error')
    with open(os.path.join(args.out, 'score.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
