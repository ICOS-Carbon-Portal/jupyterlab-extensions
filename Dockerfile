FROM quay.io/jupyter/datascience-notebook@sha256:8040395c8534cdf96388c20a85a2e89a259dbce057e67d6fd7577c2a9beea5c3

# Install Node.js.
RUN mamba install -y -q nodejs && mamba clean -afy

# Install ICOS JupyterLab extension.
#RUN pip install git+https://github.com/ICOS-Carbon-Portal/jupyterlab-extensions.git

# Install from local source (for development).
COPY --chown=${NB_UID}:${NB_GID} . /tmp/icos-ext/
WORKDIR /tmp/icos-ext
RUN pip install hatchling hatch-nodejs-version hatch-jupyter-builder && \
    jlpm install && \
    jlpm build:prod && \
    pip install --no-build-isolation . && \
    python -m icos_ext.baseline && \
    cd / && rm -rf /tmp/icos-ext

WORKDIR /home/jovyan
