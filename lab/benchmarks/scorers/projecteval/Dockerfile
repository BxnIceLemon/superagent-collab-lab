# ProjectEval judge environment. `lab bench images` adds the pinned
# checkout's requirements-docker.txt to the build context, so the packages
# are the ones ProjectEval lists for its own judge image. Chromium replaces
# Google Chrome, which has no Linux arm64 build.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium chromium-driver libgl1 libglib2.0-0 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
COPY chromium-flags /etc/chromium.d/lab

COPY requirements-docker.txt extra-requirements.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements-docker.txt -r /tmp/extra-requirements.txt \
 && pip freeze > /usr/local/share/scorer-packages.txt

COPY score.py /scorer/score.py
# Selenium Manager has no Linux arm64 build; the Debian driver is named instead.
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SE_CHROMEDRIVER=/usr/bin/chromedriver
RUN useradd --create-home scorer
USER scorer
ENTRYPOINT ["python", "/scorer/score.py"]
