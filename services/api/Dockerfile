# syntax=docker/dockerfile:1.7
FROM rust:1.94.1-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY services ./services
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --locked --release -p covechat-api && \
    cp /src/target/release/covechat-api /tmp/covechat-api

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home covechat
COPY --from=builder /tmp/covechat-api /usr/local/bin/covechat-api
USER 10001
ENV COVECHAT_API_HOST=0.0.0.0 COVECHAT_API_PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/covechat-api"]
