# arise-neko-fp: Neko + fingerprint-chromium instead of Google Chrome.
#
# The fingerprint seed is NOT baked into the image. arise-browser passes it at
# `docker run` time (ARISE_FP_SEED), so one image serves every identity.
FROM ghcr.io/m1k1o/neko/google-chrome:3.2.0

# fingerprint-chromium (https://github.com/adryfish/fingerprint-chromium),
# Linux x86_64 build. Checksum taken from the GitHub release asset digest.
ARG FP_VERSION=150.0.7871.186
ADD --checksum=sha256:48eff860053efd9ad498d51370f0a1f59f983df39c02a72ad2a8682cdead4055 \
    https://github.com/adryfish/fingerprint-chromium/releases/download/${FP_VERSION}/ungoogled-chromium-${FP_VERSION}-1-x86_64_linux.tar.xz \
    /tmp/fp-chromium.tar.xz

# socat forwards CDP from 127.0.0.1:9222 to 0.0.0.0:9223 (see supervisord.conf)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends socat xz-utils && \
    apt-get clean -y && rm -rf /var/lib/apt/lists/* && \
    mkdir -p /opt/fp-chromium && \
    tar -xJf /tmp/fp-chromium.tar.xz -C /opt/fp-chromium --strip-components=1 && \
    rm /tmp/fp-chromium.tar.xz && \
    echo "${FP_VERSION}" > /opt/fp-chromium/ARISE_FP_VERSION

# Pre-create Chrome profile directory with correct ownership
# (Docker volumes mount as root; Chrome runs as neko user)
RUN mkdir -p /home/neko/.config/arise-chrome && \
    chown -R neko:neko /home/neko/.config/arise-chrome

COPY launch-browser.sh /usr/local/bin/arise-fp-browser
RUN chmod 755 /usr/local/bin/arise-fp-browser

# Replace the upstream Chrome program with fingerprint-chromium
COPY supervisord.conf /etc/neko/supervisord/google-chrome.conf

# Chromium reads managed policies from /etc/chromium, not /etc/opt/chrome
COPY policies.json /etc/chromium/policies/managed/policies.json

EXPOSE 9223
