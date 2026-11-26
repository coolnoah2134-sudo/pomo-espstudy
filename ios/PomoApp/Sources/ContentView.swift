import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var ble: PomoBLE

    @AppStorage("pomo.task") private var task = ""
    @State private var durations: [Int] = [25, 5, 15]
    @State private var now = Date()
    @State private var toast: String?
    @State private var completionKey: String?
    @State private var showClearConfirm = false

    private let dayLabels = ["M", "T", "W", "T", "F", "S", "S"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    header
                    timerCard
                    controlsCard
                    statsCard
                    settingsCard
                    footer
                }
                .padding(16)
            }
            .background(Color.pomoBackground.ignoresSafeArea())
            .navigationBarHidden(true)
            .overlay(alignment: .bottom) { toastView }
            .alert("Clear all stats?", isPresented: $showClearConfirm) {
                Button("Cancel", role: .cancel) {}
                Button("Clear", role: .destructive) {
                    ble.send(.clearStats)
                    showToast("Stats cleared")
                }
            } message: {
                Text("This resets sessions, focus minutes and the weekly chart on the ESP32.")
            }
            .onReceive(Timer.publisher(every: 1, on: .main, in: .common)) { date in
                now = date
                checkCompletion()
            }
        }
    }

    // MARK: Header

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .stroke(Color.pomoAccent.opacity(0.7), lineWidth: 3)
                Image(systemName: "timer")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.pomoAccent)
            }
            .frame(width: 42, height: 42)

            VStack(alignment: .leading, spacing: 2) {
                Text("POMO")
                    .font(.headline)
                    .foregroundColor(.pomoText)
                Text("espstudy · ESP32-C3")
                    .font(.caption2)
                    .foregroundColor(.pomoMuted)
            }

            Spacer(minLength: 4)

            VStack(alignment: .trailing, spacing: 6) {
                HStack(spacing: 5) {
                    Circle()
                        .fill(connectionColor)
                        .frame(width: 7, height: 7)
                    Text(ble.connection.label)
                        .font(.caption2)
                        .foregroundColor(.pomoMuted)
                        .lineLimit(1)
                }

                HStack(spacing: 6) {
                    Button {
                        ble.refreshStatus()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .tint(.pomoMuted)
                    .disabled(!ble.connection.isConnected)
                    .frame(width: 34, height: 30)

                    if ble.connection.isConnected {
                        Button("Disconnect") {
                            ble.disconnect()
                        }
                        .buttonStyle(.bordered)
                        .tint(.pomoDanger)
                    } else {
                        Button("Connect") {
                            ble.connect()
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.pomoAccent)
                        .disabled(isBusy)
                    }
                }
            }
        }
    }

    // MARK: Timer card

    @ViewBuilder
    private var timerCard: some View {
        let mode = ble.status.safeMode
        let remaining = Self.remaining(from: ble.status, at: now, anchor: ble.lastStatusAt)
        let setSeconds = max(1, ble.status.set)
        let progress = min(1, max(0, 1 - Double(remaining) / Double(setSeconds)))
        let accent = color(for: mode)

        VStack(spacing: 14) {
            HStack {
                Label(mode.title, systemImage: mode.symbol)
                    .font(.caption.weight(.semibold))
                    .foregroundColor(accent)
                Spacer()
                HStack(spacing: 5) {
                    Circle()
                        .fill(ble.status.run ? Color.pomoSuccess : Color.pomoMuted)
                        .frame(width: 6, height: 6)
                    Text(ble.status.run ? "RUNNING" : "PAUSED")
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(.pomoMuted)
                }
            }

            GeometryReader { geometry in
                let diameter = min(geometry.size.width, 280)

                ZStack {
                    Circle()
                        .stroke(Color.pomoTrack, lineWidth: 12)

                    Circle()
                        .trim(from: 0, to: max(0.001, progress))
                        .stroke(
                            accent,
                            style: StrokeStyle(lineWidth: 12, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                        .animation(.easeOut(duration: 0.35), value: progress)

                    VStack(spacing: 4) {
                        Text(Self.timeString(remaining))
                            .font(.system(size: 52, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .foregroundColor(.pomoText)
                            .minimumScaleFactor(0.65)

                        Text("\(mode.shortTitle) · \(setSeconds / 60) min")
                            .font(.caption2.weight(.medium))
                            .foregroundColor(.pomoMuted)
                    }
                }
                .frame(width: diameter, height: diameter)
                .frame(maxWidth: .infinity, minHeight: 280)
            }
            .frame(height: 280)

            modeSwitch

            if let message = ble.lastMessage {
                Text(message)
                    .font(.caption2)
                    .foregroundColor(.pomoMuted)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(18)
        .cardBackground()
    }

    @ViewBuilder
    private var modeSwitch: some View {
        HStack(spacing: 4) {
            ForEach(PomoMode.allCases) { mode in
                Button {
                    ble.send(.setMode(mode.rawValue))
                } label: {
                    Text(mode.shortTitle)
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(mode == ble.status.safeMode ? .pomoText : .pomoMuted)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background(
                            mode == ble.status.safeMode
                                ? Color.pomoPanel
                                : Color.clear,
                            in: Capsule()
                        )
                }
                .buttonStyle(.plain)
                .disabled(!ble.connection.isConnected)
            }
        }
        .padding(4)
        .background(Color.pomoPanelSoft, in: Capsule())
    }

    // MARK: Controls

    @ViewBuilder
    private var controlsCard: some View {
        VStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("CURRENT TASK")
                    .font(.caption2.weight(.semibold))
                    .foregroundColor(.pomoMuted)
                TextField("What are you working on?", text: $task)
                    .textFieldStyle(.plain)
                    .padding(12)
                    .background(Color.pomoPanelSoft, in: RoundedRectangle(cornerRadius: 12))
                    .foregroundColor(.pomoText)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(Color.white.opacity(0.06), lineWidth: 1)
                    )
                Text("Saved only on this iPhone.")
                    .font(.caption2)
                    .foregroundColor(.pomoMuted)
            }

            Button {
                ble.send(ble.status.run ? .pause : .start)
            } label: {
                HStack {
                    Image(systemName: ble.status.run ? "pause.fill" : "play.fill")
                    Text(ble.status.run ? "Pause" : "Start")
                }
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(.borderedProminent)
            .tint(.pomoAccent)
            .disabled(!ble.connection.isConnected)

            HStack(spacing: 8) {
                smallButton(title: "Reset", systemImage: "arrow.counterclockwise") {
                    ble.send(.reset)
                }
                smallButton(title: "Next mode", systemImage: "forward") {
                    let next = (ble.status.mode + 1) % PomoMode.allCases.count
                    ble.send(.setMode(next))
                }
            }
        }
        .padding(18)
        .cardBackground()
    }

    @ViewBuilder
    private func smallButton(
        title: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                Text(title)
                    .font(.subheadline.weight(.medium))
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(.pomoText)
        .disabled(!ble.connection.isConnected)
    }

    // MARK: Stats

    @ViewBuilder
    private var statsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("STATS")
                .font(.caption2.weight(.semibold))
                .foregroundColor(.pomoMuted)

            HStack(spacing: 10) {
                statBox(title: "SESSIONS", value: "\(ble.status.sessions)")
                statBox(title: "FOCUS MIN", value: "\(ble.status.minutes)")
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("THIS WEEK")
                    .font(.caption2.weight(.semibold))
                    .foregroundColor(.pomoMuted)

                let daily = ble.status.daily
                let peak = max(1, daily.max() ?? 0)

                HStack(alignment: .bottom, spacing: 6) {
                    ForEach(0..<7, id: \.self) { index in
                        VStack(spacing: 4) {
                            Capsule()
                                .fill(index == 0 ? Color.pomoAccent : Color.pomoBreak.opacity(0.75))
                                .frame(
                                    width: 14,
                                    height: max(7, CGFloat(daily[index]) / CGFloat(peak) * 64)
                                )
                            Text(dayLabels[index])
                                .font(.caption2)
                                .foregroundColor(.pomoMuted)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
                .frame(height: 92)
            }
        }
        .padding(18)
        .cardBackground()
    }

    @ViewBuilder
    private func statBox(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundColor(.pomoMuted)
            Text(value)
                .font(.system(.title2, design: .rounded, weight: .semibold))
                .foregroundColor(.pomoText)
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.pomoPanelSoft, in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: Settings

    @ViewBuilder
    private var settingsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("DURATIONS")
                .font(.caption2.weight(.semibold))
                .foregroundColor(.pomoMuted)

            ForEach(0..<3, id: \.self) { index in
                Stepper(value: durationBinding(for: index), in: 1...180) {
                    HStack {
                        Text(PomoMode.allCases[index].title)
                            .font(.subheadline)
                            .foregroundColor(.pomoText)
                        Spacer()
                        Text("\(durations[index]) min")
                            .font(.subheadline.weight(.medium))
                            .foregroundColor(.pomoMuted)
                            .monospacedDigit()
                    }
                }
                .padding(.vertical, 2)
            }

            Button {
                for (index, minutes) in durations.enumerated() {
                    ble.send(.setDuration(minutes: minutes, mode: index))
                }
                showToast("Durations saved")
            } label: {
                Text("Apply to ESP32")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(.pomoAccent)
            .disabled(!ble.connection.isConnected)

            Button(role: .destructive) {
                showClearConfirm = true
            } label: {
                Text("Clear stats")
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, minHeight: 40)
            }
            .buttonStyle(.bordered)
            .tint(.pomoDanger)
            .disabled(!ble.connection.isConnected)
        }
        .padding(18)
        .cardBackground()
    }

    private func durationBinding(for index: Int) -> Binding<Int> {
        Binding(
            get: { durations[index] },
            set: { durations[index] = $0 }
        )
    }

    // MARK: Footer and toast

    @ViewBuilder
    private var footer: some View {
        VStack(spacing: 4) {
            Text("ESP32 is the source of truth")
                .font(.caption2)
                .foregroundColor(.pomoMuted)
            Text("Silent completion · no sound needed")
                .font(.caption2)
                .foregroundColor(.pomoMuted.opacity(0.8))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var toastView: some View {
        if let toast {
            Text(toast)
                .font(.subheadline.weight(.medium))
                .foregroundColor(.pomoText)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 1))
                .padding(.bottom, 22)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .animation(.easeOut(duration: 0.2), value: toast)
        }
    }

    // MARK: Helpers

    private var isBusy: Bool {
        if case .scanning = ble.connection { return true }
        if case .connecting = ble.connection { return true }
        if case .discovering = ble.connection { return true }
        return false
    }

    private var connectionColor: Color {
        switch ble.connection {
        case .connected: return .pomoSuccess
        case .failed: return .pomoDanger
        case .scanning, .connecting, .discovering: return .pomoAccent
        case .idle: return .pomoMuted
        }
    }

    private func color(for mode: PomoMode) -> Color {
        switch mode {
        case .focus: return .pomoAccent
        case .shortBreak, .longBreak: return .pomoBreak
        }
    }

    /// Display-only interpolation. The ESP32 remains authoritative; every
    /// notification or read re-anchors `rem` at `anchor`.
    private static func remaining(from status: PomoStatus, at date: Date, anchor: Date) -> Int {
        guard status.run else { return status.rem }
        let elapsed = max(0, Int(date.timeIntervalSince(anchor)))
        return max(0, status.rem - elapsed)
    }

    private static func timeString(_ seconds: Int) -> String {
        String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    private func checkCompletion() {
        let remaining = Self.remaining(from: ble.status, at: now, anchor: ble.lastStatusAt)

        if remaining > 0 {
            completionKey = nil
            return
        }
        guard ble.status.run else { return }

        let key = "\(ble.status.mode)-\(ble.status.sessions)-\(ble.status.set)"
        guard completionKey != key else { return }
        completionKey = key
        showToast("Session complete — time for a break")
    }

    private func showToast(_ message: String) {
        withAnimation { toast = message }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.2) {
            if self.toast == message {
                withAnimation { self.toast = nil }
            }
        }
    }
}

// MARK: - Card style

private extension View {
    func cardBackground() -> some View {
        self
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 22)
                    .fill(Color.pomoPanel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 22)
                    .stroke(Color.white.opacity(0.07), lineWidth: 1)
            )
    }
}
