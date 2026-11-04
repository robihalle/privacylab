# Experimental browser path

The browser uses a patched tor-js client with the Anyone directory authorities. The native snapshot process verifies consensus signatures and publishes a directory snapshot. The browser validates that snapshot again and builds its own circuit. The WebSocket bridge accepts only public IPv4 relay endpoints from the verified, unexpired directory. It forwards relay bytes with connection, duration and byte limits.

## Build the artifacts

Use Linux x86-64 for the snapshot binary. Install Rust 1.97.1 with the wasm32-unknown-unknown target, Clang, the system OpenSSL and SQLite development packages, Node.js, npm and wasm-bindgen-cli at the version in the patched Cargo.lock.

Clone these revisions into sibling directories called `arti-browser` and `tor-js`:

- [Arti browser fork](https://github.com/voltrevo/arti/tree/2527494a8961a7522a36f96d9c0048096f657c88)
- [tor-js](https://github.com/ethereum/tor-js/tree/d9d9612d10d3775ff100b70e96a291718191d856)

Apply the matching patches in `patches/` with `git am`. The directory authority and fallback values come from the [Anyone Rust client](https://github.com/anyone-protocol/anyone-rust/tree/3d447468a4ec0c536a221024ecc9fe30f18d94cf). From the patched tor-js checkout:

```sh
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0
cargo build --locked -p tor-js-gateway
CC_wasm32_unknown_unknown=clang cargo build --locked -p tor-js --target wasm32-unknown-unknown
wasm-bindgen target/wasm32-unknown-unknown/debug/tor_js.wasm --target web --out-dir crates/tor-js-wasm/pkg --out-name tor_js
npm ci
```

From the Privacy Lab checkout, pass the patched tor-js directory as `$TOR_JS`:

```sh
node wasm-bridge/build-client.mjs "$TOR_JS"
strip --strip-unneeded -o wasm-bridge/artifacts/tor-js-gateway "$TOR_JS/target/debug/tor-js-gateway"
```

Build on a distribution with glibc no newer than the Debian 13 snapshot image. The browser checks the WASM against the checksum built into its JavaScript bundle.

## Deploy

Add `deploy/compose.wasm.yaml` after the usual Compose files. Build the services and start `wasm-snapshot` and `wasm-bridge`. The named volume must be writable by the snapshot image's UID 10001 and readable by the bridge. Only the bridge needs a route from Caddy. Replace the site's final `reverse_proxy web:3000` with the handlers in `deploy/wasm-route.caddy`. Validate and reload Caddy, then check that `/wasm-lab/bootstrap` serves a snapshot. Recreate `web` with the Compose override to enable the browser option in the UI. For rollback, remove the override from the web service configuration, recreate `web`, restore the old Caddy handlers and stop the two WASM services.

The bridge trusts the client address header rewritten by Caddy and has no published port. If an external proxy is added later, configure trusted proxy addresses and adapt this header to use Caddy's validated client address.
