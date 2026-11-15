# E2EDev test environment: Behave and Selenium driving Chromium. E2EDev's step
# code opens a visible Chrome window, so tests run under Xvfb. Chromium
# replaces Google Chrome, which has no Linux arm64 build. E2EDev's
# requirements.txt lists its annotation tools; the runner itself needs only
# behave, selenium and psutil.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium chromium-driver xvfb xauth fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
COPY chromium-flags /etc/chromium.d/lab
# run_behave_test.py closes each test's browser by looking for processes named
# like "chrome"; run Chromium under that name so they are found.
RUN ln /usr/lib/chromium/chromium /usr/lib/chromium/chrome \
 && sed -i 's|exec $LIBDIR/$APPNAME |exec $LIBDIR/chrome |' /usr/bin/chromium \
 && grep -q 'exec $LIBDIR/chrome ' /usr/bin/chromium

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && pip freeze > /usr/local/share/scorer-packages.txt

COPY score.py /scorer/score.py
# Selenium Manager has no Linux arm64 build; the Debian driver is named instead.
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SE_CHROMEDRIVER=/usr/bin/chromedriver
RUN useradd --create-home scorer
USER scorer
ENTRYPOINT ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1920x1080x24", "python", "/scorer/score.py"]
