import SwiftUI

struct WaveformView: View {
    let level: Float
    private let barCount = 5
    /// Scale factors per bar — center is tallest, tapering outward symmetrically
    private let scaleFactors: [CGFloat] = [0.35, 0.7, 1.0, 0.7, 0.35]
    private let maxBarHeight: CGFloat = 28
    private let minBarHeight: CGFloat = 4

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<barCount, id: \.self) { index in
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.accentColor.gradient)
                    .frame(
                        width: 4,
                        height: barHeight(for: index)
                    )
            }
        }
        .animation(.easeOut(duration: 0.15), value: level)
    }

    private func barHeight(for index: Int) -> CGFloat {
        let normalizedLevel = CGFloat(max(0, min(1, level)))
        let scaled = normalizedLevel * scaleFactors[index] * maxBarHeight
        return max(minBarHeight, scaled + minBarHeight)
    }
}
