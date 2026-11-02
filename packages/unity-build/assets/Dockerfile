# Unity Editor image for one version + module set, built by the unity-build action
# (mode: docker) when the tag is missing on the runner's Docker daemon, or by hand:
#
#   docker build -t ci-unity-editor:2022.3.20f1-android \
#     --build-arg UNITY_VERSION=2022.3.20f1 \
#     --build-arg UNITY_CHANGESET=61c2feb0970d \
#     --build-arg UNITY_MODULES=android .
#
# The editor is installed with the Unity Hub headless CLI, so any version Hub can
# install works (the changeset comes from ProjectSettings/ProjectVersion.txt).
ARG BASE_IMAGE=ubuntu:22.04
FROM ${BASE_IMAGE}

ARG UNITY_VERSION
ARG UNITY_CHANGESET
# Space-separated Hub module ids: android ios webgl linux-il2cpp windows-mono ...
ARG UNITY_MODULES=""

ENV DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN test -n "$UNITY_VERSION" && test -n "$UNITY_CHANGESET" \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git git-lfs openssh-client unzip zip cpio xz-utils \
      xvfb xauth libgtk-3-0 libnss3 libgbm1 libasound2 libxss1 libxtst6 libsecret-1-0 \
      libnotify4 libglu1-mesa libgl1 libxrandr2 libxi6 libxcursor1 libxinerama1 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://hub.unity3d.com/linux/keys/public | gpg --dearmor -o /usr/share/keyrings/unityhub.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/unityhub.gpg] https://hub.unity3d.com/linux/repos/deb stable main" \
      > /etc/apt/sources.list.d/unityhub.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends unityhub \
 && rm -rf /var/lib/apt/lists/*

RUN printf '#!/bin/sh\nexec xvfb-run -a -e /dev/stdout /opt/unityhub/unityhub --no-sandbox --headless "$@"\n' \
      > /usr/local/bin/unity-hub \
 && chmod +x /usr/local/bin/unity-hub \
 && mkdir -p /opt/unity/editors \
 && unity-hub install-path --set /opt/unity/editors

# Hub can exit 0 after a failed download: verify the editor and each module on disk.
RUN mods=(); for m in $UNITY_MODULES; do mods+=(--module "$m"); done; \
    if [ ${#mods[@]} -gt 0 ]; then mods+=(--childModules); fi; \
    unity-hub install --version "$UNITY_VERSION" --changeset "$UNITY_CHANGESET" "${mods[@]}" 2>&1 | tee /tmp/install.log; \
    editor="/opt/unity/editors/$UNITY_VERSION/Editor"; \
    test -x "$editor/Unity" || { echo "Unity $UNITY_VERSION was not installed"; exit 1; }; \
    for m in $UNITY_MODULES; do \
      case "$m" in \
        android) d=AndroidPlayer ;; ios) d=iOSSupport ;; webgl) d=WebGLSupport ;; \
        windows-mono) d=WindowsStandaloneSupport ;; mac-mono) d=MacStandaloneSupport ;; *) d= ;; \
      esac; \
      if [ -n "$d" ] && [ ! -d "$editor/Data/PlaybackEngines/$d" ]; then echo "module $m was not installed"; exit 1; fi; \
    done; \
    rm -rf /tmp/* /root/.cache

ENV UNITY_EDITOR=/opt/unity/editors/${UNITY_VERSION}/Editor/Unity
RUN printf '#!/bin/sh\nexec xvfb-run -a -e /dev/stdout "$UNITY_EDITOR" "$@"\n' > /usr/local/bin/unity-editor \
 && chmod +x /usr/local/bin/unity-editor

LABEL org.opencontainers.image.title="Unity Editor ${UNITY_VERSION}" \
      ci-sdk.unity.version="${UNITY_VERSION}" \
      ci-sdk.unity.changeset="${UNITY_CHANGESET}" \
      ci-sdk.unity.modules="${UNITY_MODULES}"

WORKDIR /project
