import { $ } from 'bun';

// 1. Build the sidecar binary for arm64-darwin
await $`bun build --compile --target=bun-darwin-arm64 apps/core-runtime/src/main.ts --outfile apps/mac/EchoScribe/Resources/core-runtime`;

// 2. Build the React UI
await $`bun run --cwd packages/ui build`;

// 3. Copy UI dist to Mac app resources
await $`cp -r packages/ui/dist apps/mac/EchoScribe/Resources/ui`;

// 4. Build the Xcode project
await $`xcodebuild -project apps/mac/EchoScribe.xcodeproj -scheme EchoScribe -configuration Release`;
