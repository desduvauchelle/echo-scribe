// swift-tools-version: 5.10
// Beta sidecar: drives NVIDIA PersonaPlex-7B (full-duplex speech-to-speech)
// on Apple Silicon through the speech-swift MLX runtime. Built + installed by
// scripts/build-personaplex-sidecar.sh; NOT part of the app bundle or CI.
import PackageDescription

let package = Package(
    name: "echo-scribe-personaplex",
    platforms: [.macOS("15.0")],
    dependencies: [
        // Pinned to a release tag and patched (see patches/) by the build script.
        .package(path: ".deps/speech-swift"),
    ],
    targets: [
        .executableTarget(
            name: "echo-scribe-personaplex",
            dependencies: [
                .product(name: "PersonaPlex", package: "speech-swift"),
                .product(name: "AudioCommon", package: "speech-swift"),
            ],
            path: "Sources/echo-scribe-personaplex"
        ),
    ]
)
