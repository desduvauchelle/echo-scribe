import SwiftUI

struct WaveformView: View {
    let level: Float
    @State private var bars: [CGFloat] = Array(repeating: 0.1, count: 20)

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<bars.count, id: \.self) { index in
                RoundedRectangle(cornerRadius: 2)
                    .fill(.blue.gradient)
                    .frame(width: 4, height: max(4, bars[index] * 60))
            }
        }
        .onChange(of: level) { _, newLevel in
            withAnimation(.easeOut(duration: 0.1)) {
                bars.removeFirst()
                bars.append(CGFloat(newLevel))
            }
        }
    }
}
