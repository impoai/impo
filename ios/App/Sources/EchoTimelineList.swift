import SwiftUI
import InstantClient

/// UIKit keeps exact geometry for every slot while recycling only visible cells.
/// Loading/evicting a body never inserts/removes a row or changes its height.
struct EchoTimelineList: UIViewRepresentable {
    let model: EchoTimelineModel
    let indexVersion: UUID
    let contentVersion: UUID
    let navigation: UUID
    let targetDay: String?
    let rowHeight: CGFloat
    let headerHeight: CGFloat
    let visibleDay: (String) -> Void
    let select: (ListeningSegment) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UICollectionView {
        let layout = UICollectionViewFlowLayout()
        layout.minimumLineSpacing = 0; layout.minimumInteritemSpacing = 0
        layout.sectionInset = UIEdgeInsets(top: 0, left: 22, bottom: 0, right: 84)
        let view = UICollectionView(frame: .zero, collectionViewLayout: layout)
        view.backgroundColor = UIColor(InstantStyle.paper)
        view.alwaysBounceVertical = true; view.showsVerticalScrollIndicator = false
        view.accessibilityIdentifier = "echo.timeline"
        view.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "recording")
        view.register(UICollectionViewCell.self, forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader, withReuseIdentifier: "day")
        view.delegate = context.coordinator
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.refresh), for: .valueChanged)
        view.refreshControl = refresh
        context.coordinator.connect(view)
        return view
    }
    func updateUIView(_ view: UICollectionView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.update(view)
    }

    @MainActor final class Coordinator: NSObject, UICollectionViewDelegateFlowLayout {
        var parent: EchoTimelineList
        weak var view: UICollectionView?
        var source: UICollectionViewDiffableDataSource<String, String>!
        private var indexVersion: UUID?
        private var contentVersion: UUID?
        private var navigation: UUID?
        private var rowHeight: CGFloat?
        private var reporting: Task<Void, Never>?
        init(_ parent: EchoTimelineList) { self.parent = parent }

        func connect(_ view: UICollectionView) {
            self.view = view
            source = UICollectionViewDiffableDataSource(collectionView: view) { [weak self] view, path, id in
                let cell = view.dequeueReusableCell(withReuseIdentifier: "recording", for: path)
                self?.configure(cell, id: id)
                return cell
            }
            source.supplementaryViewProvider = { [weak self] view, kind, path in
                let cell = view.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: "day", for: path) as! UICollectionViewCell
                if let self, let day = self.source.snapshot().sectionIdentifiers[safe: path.section] {
                    cell.contentConfiguration = UIHostingConfiguration {
                        Text(EchoDates.date(day)?.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()) ?? day)
                            .font(InstantStyle.serif(23)).foregroundStyle(InstantStyle.ink)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading).padding(.bottom, 12)
                    }.margins(.leading, 22).margins(.trailing, 84).margins(.vertical, 0)
                }
                return cell
            }
        }

        private func configure(_ cell: UICollectionViewCell, id: String) {
            let record = parent.model.records[id], failed = parent.model.failures.contains(id)
            cell.contentConfiguration = UIHostingConfiguration {
                EchoTimelineRow(segment: record, failed: failed, retry: { [weak self] in self?.parent.model.retry() }, select: { [weak self] in
                    if let record { self?.parent.select(record) }
                })
            }.margins(.all, 0)
        }

        func update(_ view: UICollectionView) {
            if rowHeight != parent.rowHeight {
                rowHeight = parent.rowHeight; view.collectionViewLayout.invalidateLayout()
            }
            if indexVersion != parent.indexVersion {
                // Preserve an actual visible recording on insert/delete, not an offset page.
                let top = view.indexPathsForVisibleItems.sorted().first
                let anchor = top.flatMap { source.itemIdentifier(for: $0) }
                let inset = top.flatMap { view.layoutAttributesForItem(at: $0)?.frame.minY }.map { $0 - view.contentOffset.y }
                let preserveAnchor = view.contentOffset.y > 10
                indexVersion = parent.indexVersion
                var snapshot = NSDiffableDataSourceSnapshot<String, String>()
                for day in parent.model.days {
                    snapshot.appendSections([day.date]); snapshot.appendItems(day.ids, toSection: day.date)
                }
                source.apply(snapshot, animatingDifferences: false)
                view.layoutIfNeeded()
                if preserveAnchor, let anchor, let inset, let path = source.indexPath(for: anchor),
                   let frame = view.layoutAttributesForItem(at: path)?.frame {
                    view.setContentOffset(CGPoint(x: 0, y: max(0, frame.minY - inset)), animated: false)
                }
            }
            if contentVersion != parent.contentVersion {
                contentVersion = parent.contentVersion
                for path in view.indexPathsForVisibleItems {
                    if let id = source.itemIdentifier(for: path), let cell = view.cellForItem(at: path) { configure(cell, id: id) }
                }
            }
            if navigation != parent.navigation, !parent.model.days.isEmpty {
                navigation = parent.navigation
                let day = parent.model.days.first { $0.date == parent.targetDay } ?? parent.model.days[0]
                if let id = day.ids.first, let path = source.indexPath(for: id) {
                    view.layoutIfNeeded()
                    let header = view.layoutAttributesForSupplementaryElement(ofKind: UICollectionView.elementKindSectionHeader, at: IndexPath(item: 0, section: path.section))
                    view.setContentOffset(CGPoint(x: 0, y: max(0, header?.frame.minY ?? 0)), animated: false)
                }
            }
            reportViewport()
        }

        func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, sizeForItemAt: IndexPath) -> CGSize {
            CGSize(width: max(1, collectionView.bounds.width - 106), height: parent.rowHeight)
        }
        func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, referenceSizeForHeaderInSection: Int) -> CGSize {
            CGSize(width: collectionView.bounds.width, height: parent.headerHeight)
        }
        func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt: IndexPath) { reportViewport() }
        func scrollViewDidScroll(_ scrollView: UIScrollView) { reportViewport() }

        private func reportViewport() {
            guard reporting == nil else { return }
            // Defer changes until UIKit has finished layout and SwiftUI's update transaction.
            reporting = Task { [weak self] in
                await Task.yield()
                guard let self, let view else { return }
                self.reporting = nil
                let paths = view.indexPathsForVisibleItems.sorted()
                self.parent.model.show(paths.compactMap { self.source.itemIdentifier(for: $0) })
                if let top = paths.first, let day = self.source.snapshot().sectionIdentifiers[safe: top.section] { self.parent.visibleDay(day) }
            }
        }

        @objc func refresh() {
            Task { [weak self] in
                guard let self else { return }
                await parent.model.refresh()
                view?.refreshControl?.endRefreshing()
            }
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

private struct EchoTimelineRow: View {
    let segment: ListeningSegment?
    let failed: Bool
    let retry: () -> Void
    let select: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let segment {
                Button(action: select) {
                    VStack(alignment: .leading, spacing: 9) {
                        HStack {
                            Text(segment.recordedAt.formatted(date: .omitted, time: .shortened)).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                            Text(segment.durationLabel).font(.caption).foregroundStyle(InstantStyle.muted)
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(InstantStyle.muted)
                        }
                        if let place = segment.location?.displayLabel {
                            Label(place, systemImage: "mappin.and.ellipse").font(.caption).foregroundStyle(InstantStyle.muted).lineLimit(1)
                                .accessibilityIdentifier("echo.row.location")
                        }
                        Text(segment.isSilent ? "No speech was detected." : segment.displayTranscript)
                            .font(.body).lineSpacing(4).lineLimit(3)
                            .foregroundStyle(segment.status == "transcribed" ? InstantStyle.ink : InstantStyle.muted)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("listening.recording.\(segment.id)")
            } else if failed {
                Button(action: retry) {
                    Label("Couldn't load this recording. Tap to retry.", systemImage: "arrow.clockwise")
                        .font(.subheadline).foregroundStyle(InstantStyle.muted)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }.accessibilityIdentifier("echo.retry-recording")
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    RoundedRectangle(cornerRadius: 3).frame(width: 72, height: 12)
                    RoundedRectangle(cornerRadius: 3).frame(height: 14)
                    RoundedRectangle(cornerRadius: 3).frame(height: 14)
                    RoundedRectangle(cornerRadius: 3).frame(width: 120, height: 14)
                }.foregroundStyle(InstantStyle.border.opacity(0.5))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .accessibilityElement(children: .ignore).accessibilityLabel("Loading recording")
                    .accessibilityIdentifier("echo.recording-placeholder")
            }
            Divider().overlay(InstantStyle.border.opacity(0.6)).padding(.top, 12)
        }.padding(.vertical, 12).foregroundStyle(InstantStyle.ink)
    }
}
