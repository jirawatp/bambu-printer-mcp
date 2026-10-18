# Docker runtime

Docker is the intended deployment path for this prototype. It still runs only synthetic printers. The container has no device discovery, physical printer transport or persistent data service.

## Build once for this Mac's architecture

With a Docker-compatible daemon already running:

```sh
docker build --tag bambu-printer-mcp:local .
```

The multi-stage build installs the lockfile with lifecycle scripts disabled, runs all unit and MCP stdio tests inside the builder, removes development dependencies, and copies only compiled server code and production dependencies into the runtime. The official Node 24 Alpine base is pinned to a multi-architecture digest in `Dockerfile`; it includes Linux arm64 and amd64. Build natively on Apple Silicon; no emulation or multi-platform build is needed for local use.

The pin fixes the base contents and npm's lockfile fixes package contents; this is reproducible dependency selection, not a claim of byte-identical image digests or an automatic security-update mechanism. Review/update the base digest and lockfile deliberately and rerun checks. No registry login or image publishing is required. The runtime uses UID/GID 1000 (`node`); application files are root-owned and cannot be edited by that user.

## Run over MCP stdio

```sh
docker run --rm --interactive --init --pull=never \
  --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --cpus 0.5 --memory 256m --pids-limit 64 --log-driver none \
  bambu-printer-mcp:local
```

Keep stdin attached with `--interactive`; omit `--tty` because a terminal can alter MCP framing. No published port, volume, device, host networking or Docker socket mount is needed. The process waits for an MCP client; an empty terminal is expected. Mock controls/camera remain disabled. To exercise simulations only, append `--enable-mock-controls` and/or `--enable-mock-camera` after the image name.

For an MCP host accepting `mcpServers` configuration:

```json
{
  "mcpServers": {
    "bambu-printer-mock": {
      "command": "docker",
      "args": [
        "run", "--rm", "--interactive", "--init", "--pull=never",
        "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--cpus", "0.5",
        "--memory", "256m", "--pids-limit", "64", "--log-driver", "none",
        "bambu-printer-mcp:local"
      ]
    }
  }
}
```

Use the full path to Docker if the host cannot find it. One container belongs to each MCP session and is removed when that session ends. Direct `docker run` keeps stdio attached, so no Compose service is needed.

## Verify the image

With local development dependencies installed and the image built:

```sh
npm ci --ignore-scripts
npm run test:docker
```

The smoke test launches a restricted container through the official MCP client, verifies the five fixtures and X2D telemetry, and checks that controls and camera default off. It cleans up only its own named disposable container. CI also inspects non-root image configuration, production-only dependencies and image size. No image is pushed to a registry. CI's Docker job validates Linux amd64; a native Apple Silicon image still needs local build/run validation.

## Keep Mac resource use modest

The runtime is limited to 0.5 CPU, 256 MiB RAM and 64 processes; Node's old-space heap limit is 128 MiB. Containers have a read-only filesystem, no persistent volumes, and Docker log storage is disabled. Build layers/cache and the Docker VM still use disk/RAM outside those runtime limits. Build one native image, reuse it, and avoid repeated clean builds. The allowlisted build context excludes host `node_modules`, `dist`, `.git`, local configuration and secrets.

Check `docker system df` before deciding on cleanup. Removing this project's image with `docker image rm bambu-printer-mcp:local` after its sessions stop is scoped to this tag; do not run broad prune commands as part of setup. This work does not change Docker Desktop/Rancher VM allocations or start a stopped daemon. A failed connection to the Docker socket means the owner must start their chosen engine when ready.

Docker documentation checked on 2026-10-18: [multi-stage builds](https://docs.docker.com/build/building/multi-stage/), [runtime options](https://docs.docker.com/reference/cli/docker/container/run/). These controls contain the simulator; they do not validate printer protocols or authorize hardware access.
