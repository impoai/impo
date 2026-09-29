import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct ListeningWidgetBundle: WidgetBundle {
    var body: some Widget { ListeningActivityWidget() }
}

struct ListeningActivityWidget: Widget {
    private let forest = Color(red: 0.16, green: 0.29, blue: 0.23)
    private let orange = Color(red: 0.81, green: 0.32, blue: 0.18)

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ListeningActivityAttributes.self) { context in
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(title(context)).font(.custom("Georgia", size: 23, relativeTo: .title3))
                    if context.isStale {
                        Text("Open Impo to check").font(.caption)
                    } else if !context.state.isRecording {
                        Text("Microphone paused").font(.caption)
                    } else {
                        Text(context.state.timerStartedAt ?? context.attributes.startedAt, style: .timer)
                            .monospacedDigit().font(.system(size: 14, weight: .medium))
                            .frame(width: 85, alignment: .leading)
                    }
                }.foregroundStyle(EchoWaveform.paper).layoutPriority(1)
                waveform(context).frame(maxWidth: .infinity).frame(height: 64)
                stopButton(context)
            }.padding(18).foregroundStyle(EchoWaveform.paper)
                .activityBackgroundTint(forest)
                .activitySystemActionForegroundColor(EchoWaveform.paper)
                .widgetURL(URL(string: "ai.impo://listening"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(title(context)).font(.custom("Georgia", size: 20)).foregroundStyle(EchoWaveform.paper)
                }
                DynamicIslandExpandedRegion(.center) {
                    waveform(context).frame(width: 95, height: 32)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if !context.isStale && context.state.isRecording { timer(context).font(.title3) }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Link(context.isStale ? "Check recording" : "Open Echo", destination: URL(string: "ai.impo://listening")!)
                        Spacer()
                        stopButton(context)
                    }.padding(.top, 6)
                }
            } compactLeading: {
                compactWaveform(context)
            } compactTrailing: {
                if context.isStale { Image(systemName: "exclamationmark").foregroundStyle(orange) }
                else if !context.state.isRecording { Image(systemName: "pause.fill").foregroundStyle(orange) }
                else { timer(context).frame(width: 54).font(.caption.monospacedDigit()) }
            } minimal: {
                compactWaveform(context)
            }
            .widgetURL(URL(string: "ai.impo://listening"))
            .keylineTint(orange)
        }
    }

    private func title(_ context: ActivityViewContext<ListeningActivityAttributes>) -> String {
        context.isStale ? "Check Echo" : !context.state.isRecording ? "Echo paused" : context.attributes.isPreview ? "Echo preview" : "Echo"
    }
    private func symbol(_ context: ActivityViewContext<ListeningActivityAttributes>) -> String {
        context.isStale ? "mic.slash" : context.state.isRecording ? "waveform" : "pause.circle"
    }
    private func timer(_ context: ActivityViewContext<ListeningActivityAttributes>) -> some View {
        Text(context.state.timerStartedAt ?? context.attributes.startedAt, style: .timer).monospacedDigit().foregroundStyle(.primary)
    }
    private func waveform(_ context: ActivityViewContext<ListeningActivityAttributes>) -> some View {
        EchoWaveform(levels: context.state.waveform ?? [], isRecording: context.state.isRecording && !context.isStale,
                     isSpeaking: context.state.isSpeaking ?? false)
            .accessibilityLabel(context.state.isSpeaking == true ? "Speech detected" : "Microphone level")
    }
    @ViewBuilder private func compactWaveform(_ context: ActivityViewContext<ListeningActivityAttributes>) -> some View {
        if context.isStale || !context.state.isRecording {
            Image(systemName: symbol(context)).foregroundStyle(orange)
        } else {
            EchoWaveform(levels: Array((context.state.waveform ?? []).suffix(8)), isRecording: true,
                         isSpeaking: context.state.isSpeaking ?? false, compact: true).frame(width: 24, height: 18)
        }
    }
    private func stopButton(_ context: ActivityViewContext<ListeningActivityAttributes>) -> some View {
        Button(intent: StopListeningIntent(sessionID: context.attributes.sessionID)) {
            Image(systemName: "stop.fill").font(.system(size: 14, weight: .semibold)).frame(width: 44, height: 44)
        }.buttonStyle(.plain).foregroundStyle(forest).background(EchoWaveform.paper, in: Circle())
            .accessibilityLabel("Stop Echo recording")
    }
}
