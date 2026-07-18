FROM rust:1.91-bookworm AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY services ./services
RUN cargo build --locked --release -p covechat-api

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home covechat
COPY --from=builder /src/target/release/covechat-api /usr/local/bin/covechat-api
USER 10001
ENV COVECHAT_API_HOST=0.0.0.0 COVECHAT_API_PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/covechat-api"]
