FROM node:26.13.0-bookworm

# Node 26 no longer ships Corepack. pnpm is installed from the packageManager pin.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --allow-scripts=pnpm pnpm@12.16.1

COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /uvx /usr/local/bin/

ENV UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
    UV_PYTHON=3.14.10 \
    UV_LINK_MODE=copy

RUN uv python install 3.14.10

USER node
WORKDIR /workspaces/lunarhunt
