import Foundation

// MARK: - Modes

enum PomoMode: Int, CaseIterable, Identifiable {
    case focus = 0
    case shortBreak = 1
    case longBreak = 2

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .focus: return "FOCUS"
        case .shortBreak: return "SHORT BREAK"
        case .longBreak: return "LONG BREAK"
        }
    }

    var shortTitle: String {
        switch self {
        case .focus: return "FOCUS"
        case .shortBreak: return "SHORT"
        case .longBreak: return "LONG"
        }
    }

    var symbol: String {
        switch self {
        case .focus: return "target"
        case .shortBreak: return "cup.and.saucer"
        case .longBreak: return "figure.walk"
        }
    }
}

// MARK: - Device status

/// Mirrors the exact JSON published by the ESP32 status characteristic.
/// The ESP32 is the source of truth; this is only the last received snapshot.
struct PomoStatus: Codable, Equatable {
    var mode: Int = 0
    var rem: Int = 1500
    var set: Int = 1500
    var run: Bool = false
    var sessions: Int = 0
    var minutes: Int = 0
    var daily: [Int] = Array(repeating: 0, count: 7)

    var safeMode: PomoMode {
        PomoMode(rawValue: mode) ?? .focus
    }

    private enum CodingKeys: String, CodingKey {
        case mode, rem, set, run, sessions, minutes, daily
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decodeIfPresent(Int.self, forKey: .mode) ?? 0
        rem = try container.decodeIfPresent(Int.self, forKey: .rem) ?? 1500
        set = try container.decodeIfPresent(Int.self, forKey: .set) ?? 1500
        run = try container.decodeIfPresent(Bool.self, forKey: .run) ?? false
        sessions = try container.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
        minutes = try container.decodeIfPresent(Int.self, forKey: .minutes) ?? 0

        let received = try container.decodeIfPresent([Int].self, forKey: .daily) ?? []
        daily = (0..<7).map { index in
            received.indices.contains(index) ? received[index] : 0
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(mode, forKey: .mode)
        try container.encode(rem, forKey: .rem)
        try container.encode(set, forKey: .set)
        try container.encode(run, forKey: .run)
        try container.encode(sessions, forKey: .sessions)
        try container.encode(minutes, forKey: .minutes)
        try container.encode(daily, forKey: .daily)
    }
}

// MARK: - Commands

/// Commands understood by the firmware command characteristic.
enum PomoCommand {
    case toggle
    case start
    case pause
    case reset
    case status
    case clearStats
    case setMode(Int)
    case setDuration(minutes: Int, mode: Int?)

    var json: String {
        switch self {
        case .toggle:
            return "{\"cmd\":\"toggle\"}"
        case .start:
            return "{\"cmd\":\"start\"}"
        case .pause:
            return "{\"cmd\":\"pause\"}"
        case .reset:
            return "{\"cmd\":\"reset\"}"
        case .status:
            return "{\"cmd\":\"status\"}"
        case .clearStats:
            return "{\"cmd\":\"clearstats\"}"
        case .setMode(let value):
            return "{\"cmd\":\"mode\",\"value\":\(value)}"
        case .setDuration(let minutes, let mode):
            if let mode {
                return "{\"cmd\":\"set\",\"value\":\(minutes),\"mode\":\(mode)}"
            }
            return "{\"cmd\":\"set\",\"value\":\(minutes)}"
        }
    }

    var data: Data { Data(json.utf8) }
}
