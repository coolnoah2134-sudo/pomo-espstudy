import SwiftUI

extension Color {
    init(hex: Int) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }

    static let pomoBackground = Color(hex: 0x0B0D11)
    static let pomoPanel = Color(hex: 0x171B23)
    static let pomoPanelSoft = Color(hex: 0x1C212A)
    static let pomoTrack = Color(hex: 0x232A33)
    static let pomoText = Color(hex: 0xF2F3F5)
    static let pomoMuted = Color(hex: 0x8B929C)
    static let pomoAccent = Color(hex: 0xFF6B5A)
    static let pomoBreak = Color(hex: 0x7FB3C8)
    static let pomoSuccess = Color(hex: 0x66D39B)
    static let pomoDanger = Color(hex: 0xFF8A80)
}
