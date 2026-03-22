import SwiftUI

struct WaveformView: View {
    let level: Float
    private let barCount = 20
    @State private var bars: [CGFloat] = Array(repeating: 0.1, count: 20)

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<barCount, id: \.self) { index in
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.accentColor.gradient)
                    .frame(width: 4, height: max(4, bars[index] * 60))
            }
        }
        .onChange(of: level) { _, newLevel in
            withAnimation(.easeOut(duration: 0.1)) {
                // Shift values in-place to avoid array size changes during animation
                for i in 0..<(barCount - 1) {
                    bars[i] = bars[i + 1]
                }
                bars[barCount - 1] = CGFloat(newLevel)
            }
        }
    }
}
