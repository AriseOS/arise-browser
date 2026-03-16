FROM ghcr.io/m1k1o/neko/google-chrome:latest

# socat to forward CDP from 127.0.0.1:9222 to 0.0.0.0:9223
# (Chrome ignores --remote-debugging-address in newer versions)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends socat && \
    apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Pre-create Chrome profile directory with correct ownership
# (Docker volumes mount as root; Chrome runs as neko user)
RUN mkdir -p /home/neko/.config/arise-chrome && \
    chown -R neko:neko /home/neko/.config/arise-chrome

# Override supervisord config to enable CDP (--remote-debugging-port=9222)
COPY supervisord.conf /etc/neko/supervisord/google-chrome.conf

# Chrome managed policies (allow DevTools/CDP, popups, disable autofill)
COPY policies.json /etc/opt/chrome/policies/managed/policies.json

EXPOSE 9223
