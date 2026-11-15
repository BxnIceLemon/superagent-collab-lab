"""Scores one ProjectEval project with ProjectEval's own judge.

Runs inside the projecteval scorer image. The benchmark checkout is mounted
read-only at /bench, the agent's workspace at /workspace, and results are
written to /out. The judge itself is unchanged: this script only does what
run_judge.py does for one project, with the agent's files converted by the
benchmark's tools/file_transform.py.

The judge asks a model for the test parameters (element ids, URLs) by reading
the submitted code. That model is fixed for every condition (--judge-model)
and reached through ProjectEval's DeepSeekTest class.
"""
import argparse
import configparser
import importlib.util
import json
import os
import shutil
import signal
import socket
import sys
import time

# Folders an agent may leave in its workspace that are not part of the project.
NOT_PROJECT = {'.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache'}
# Code and data the judge needs; the rest of the checkout is figures and results.
BENCH_PARTS = ['config.ini', 'data', 'tools']
# Seconds to wait for the Django server to accept connections.
SERVER_WAIT = 20


def copy_bench(bench: str, work: str) -> None:
    os.makedirs(work, exist_ok=True)
    for name in os.listdir(bench):
        source = os.path.join(bench, name)
        if name.endswith('.py'):
            shutil.copy2(source, work)
        elif name in BENCH_PARTS:
            (shutil.copytree if os.path.isdir(source) else shutil.copy2)(source, os.path.join(work, name))


def write_key(work: str) -> None:
    """config.py reads DEEPSEEK_KEY from config.ini; the key comes from the environment and stays in /tmp."""
    path = os.path.join(work, 'config.ini')
    config = configparser.ConfigParser()
    config.optionxform = str
    config.read(path, encoding='utf-8')
    config['Default']['DEEPSEEK_KEY'] = os.environ.get('DEEPSEEK_API_KEY', '')
    with open(path, 'w', encoding='utf-8') as f:
        config.write(f)


def adapt_to_linux(openjudge) -> None:
    """Two runtime adaptations; ProjectEval's code itself is not changed.

    - The judge opens the home page right after starting `manage.py runserver`.
      On Windows the shell launch gives the server time to bind; on Linux the
      visit comes first and fails, so the start waits until port 8000 accepts
      connections, or the server exits, or SERVER_WAIT seconds pass.
    - The judge stops the server with signal.CTRL_BREAK_EVENT, which exists
      only on Windows; on Linux SIGTERM does the same.
    """
    if not hasattr(signal, 'CTRL_BREAK_EVENT'):
        signal.CTRL_BREAK_EVENT = signal.SIGTERM
    server = openjudge.WebsiteJudge.DjangoServer
    original_start = server.start

    def start_and_wait(self):
        original_start(self)
        deadline = time.monotonic() + SERVER_WAIT
        while time.monotonic() < deadline and self.process.poll() is None:
            try:
                socket.create_connection(('127.0.0.1', 8000), timeout=1).close()
                return
            except OSError:
                time.sleep(0.2)

    server.start = start_and_wait


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--item', required=True, help='ProjectEval project_id, "1" to "20"')
    parser.add_argument('--level', type=int, default=1)
    parser.add_argument('--judge-model', default='deepseek-flash')
    parser.add_argument('--bench', default='/bench')
    parser.add_argument('--workspace', default='/workspace')
    parser.add_argument('--out', default='/out')
    args = parser.parse_args()

    work = '/tmp/projecteval'
    copy_bench(args.bench, work)
    write_key(work)
    os.chdir(work)
    sys.path.insert(0, work)
    os.makedirs('data/parameter_answer_save', exist_ok=True)

    submission = '/tmp/submission'
    shutil.copytree(args.workspace, submission, ignore=shutil.ignore_patterns(*NOT_PROJECT))
    spec = importlib.util.spec_from_file_location('file_transform', os.path.join(work, 'tools/file_transform.py'))
    file_transform = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(file_transform)
    answer_dir = f'experiments/lab/{args.judge_model}/direct'
    os.makedirs(answer_dir, exist_ok=True)
    answer_path = f'{answer_dir}/lab_00000000-000000_level_{args.level}.json'
    with open(answer_path, 'w', encoding='utf-8') as f:
        json.dump({args.item: file_transform.project_to_json(submission)}, f, ensure_ascii=False)

    from controller import JudgeController
    from llm import DeepSeekTest
    import openjudge

    adapt_to_linux(openjudge)

    # As run_judge.py sets them: fixed packages, and Django's default initiation.
    if args.item in {str(i) for i in range(16, 20)}:
        initiate_command, requirements = {args.item: []}, {args.item: ['openpyxl', 'pandas']}
    else:
        initiate_command = {args.item: [[]]}
        requirements = {args.item: ['django', 'matplotlib', 'pyperclip', 'qrcode', 'markdown']}

    tester = JudgeController(
        question_path='data/project_eval_project.json',
        answer_path=answer_path,
        model_class=DeepSeekTest,
        parameter_file_path=None,
        llm=args.judge_model,
        device='',
    )
    score, _ = tester.evaluate(initiate_command, requirements, project_id_list=[args.item], start_file_list=None)

    with open('data/project_eval_project.json', encoding='utf-8') as f:
        project = next(p for p in json.load(f) if p['project_id'] == args.item)
    # One case per test function, plus one for the project running at all, as the judge counts them.
    cases = sum(len(page['function']) for page in project['testcode']) + 1
    result = {
        'benchmark': 'projecteval',
        'item': args.item,
        'level': args.level,
        'judgeModel': args.judge_model,
        'metrics': {'passed': score['pass'], 'cases': cases, 'passRate': score['pass'] / cases},
    }
    os.makedirs(args.out, exist_ok=True)
    for name in os.listdir('data/parameter_answer_save'):
        shutil.copy2(os.path.join('data/parameter_answer_save', name), os.path.join(args.out, 'parameters.json'))
    if os.path.isdir('log'):
        shutil.copytree('log', os.path.join(args.out, 'log'), dirs_exist_ok=True)
    with open(os.path.join(args.out, 'score.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
