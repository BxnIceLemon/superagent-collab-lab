# Runs NL2Repo-Bench's post-processing, which drives Docker through
# python-on-whales: the scorer needs the Docker CLI and buildx, and the
# daemon's socket is mounted when it runs. The task test images are
# linux/amd64; on an arm64 host the daemon runs them through emulation.
FROM docker:29.2.1-cli AS docker

FROM python:3.12-slim-bookworm
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && pip freeze > /usr/local/share/scorer-packages.txt

COPY score.py /scorer/score.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/scorer/score.py"]
