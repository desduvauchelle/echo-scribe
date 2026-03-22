// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "EchoScribe",
    platforms: [
        .macOS(.v15)
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
        .package(url: "https://github.com/ml-explore/mlx-swift-lm.git", from: "2.30.0"),
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", from: "0.16.0"),
        .package(url: "https://github.com/sindresorhus/KeyboardShortcuts.git", from: "2.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "EchoScribe",
            dependencies: [
                .product(name: "GRDB", package: "GRDB.swift"),
                .product(name: "MLXLLM", package: "mlx-swift-lm"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "WhisperKit", package: "WhisperKit"),
                .product(name: "KeyboardShortcuts", package: "KeyboardShortcuts"),
            ],
            path: "EchoScribe"
        ),
    ]
)
