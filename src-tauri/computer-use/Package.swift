// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TuckyComputerUse",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "tucky-computer-use", targets: ["TuckyComputerUse"])],
    targets: [
        .target(name: "ComputerUseCore"),
        .executableTarget(name: "TuckyComputerUse", dependencies: ["ComputerUseCore"]),
        .testTarget(name: "ComputerUseCoreTests", dependencies: ["ComputerUseCore"]),
    ]
)
