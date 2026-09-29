#if DEBUG
import SwiftUI

/// Isolated UI acceptance surface, excluded from release builds.
struct ResponseRenderingFixture: View {
    @State private var mode = 0
    @State private var streaming = ""
    @State private var streamTask: Task<Void, Never>?
    private let example = #"""
    ## 对数求导

    比如 **函数** \(y=x^x\)。先取对数，再求导：

    \[
    \frac{y'}{y}=\ln x+1
    \]

    所以 $y'=x^x(\ln x+1)$。

    ### Quick reference

    | Function | Derivative | Description |
    | :--- | :---: | ---: |
    | $\ln x$ | $1/x$ | Natural logarithm |
    | $x^n$ | $nx^{n-1}$ | Constant exponent |

    - Take the logarithm.
      - Keep both sides equal.
    - Differentiate.
    - Multiply by the original function.

    > This method also helps with products and quotients.

    ```swift
    let derivative = pow(x, x) * (log(x) + 1)
    // Keep $ and \[literal\] unchanged in code.
    ```

    Read the [documentation](https://impo.ai). Budget example: $5 and $10.
    """#

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Example", selection: $mode) {
                    Text("Rich reply").tag(0)
                    Text("Streaming").tag(1)
                    Text("Long chat").tag(2)
                }.pickerStyle(.segmented).padding()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            if mode == 0 { reply(example) }
                            if mode == 1 {
                                Button("Start streaming") { startStreaming() }.accessibilityIdentifier("response.fixture.stream")
                                if !streaming.isEmpty { reply(streaming) }
                            }
                            if mode == 2 {
                                ForEach(0..<100, id: \.self) { index in
                                    reply("## Answer \(index + 1)\n\nA readable response with **important details**, a short list, and some context.\n\n- First point\n- Second point\n\nEnd of answer \(index + 1).")
                                        .id(index)
                                }
                            }
                        }.padding(19)
                    }.accessibilityIdentifier("response.fixture.scroll")
                    if mode == 2 {
                        Button("Latest answer") { proxy.scrollTo(99, anchor: .bottom) }
                            .padding().accessibilityIdentifier("response.fixture.latest")
                    }
                }
            }
            .background(InstantStyle.paper)
            .navigationTitle("Response preview").navigationBarTitleDisplayMode(.inline)
        }
        .onDisappear { streamTask?.cancel() }
    }

    private func reply(_ text: String) -> some View {
        AssistantMarkdown(text: text).padding(14)
            .background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(InstantStyle.border, lineWidth: 0.7))
    }

    private func startStreaming() {
        streamTask?.cancel()
        streaming = "## Streaming response\n\nFirst paragraph is ready for selection."
        streamTask = Task { @MainActor in
            let parts = ["\n\nNext: ", #"\["#, #"\frac{1}{2}"#, #"\]"#, "\n\n| A | B |", "\n| --- | --- |", "\n| one | two |", "\n\nThe response is complete."]
            for part in parts {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                streaming += part
            }
        }
    }
}
#endif
