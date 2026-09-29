import XCTest
import InstantClient
@testable import Instant

@MainActor final class EchoHistoryTests: XCTestCase {
    private func model() throws -> (ListeningModel, URLSession, URL) {
        EchoHistoryProtocol.state.reset()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [EchoHistoryProtocol.self]
        let session = URLSession(configuration: config)
        let model = ListeningModel(storageRoot: root)
        model.configure(scope: "echo-test", client: InstantClient(baseURL: URL(string: "https://echo-test.invalid")!, bearerToken: "test", session: session))
        return (model, session, root)
    }
    func testWindowStaysBoundedAndEvictedRecordsCanBeLoadedInBothDirections() async throws {
        let (model, session, root) = try model()
        defer { model.stop(); session.invalidateAndCancel(); try? FileManager.default.removeItem(at: root) }
        await model.refreshHistory(); XCTAssertEqual(model.history.count, 30)
        for _ in 0..<8 { await model.loadMoreHistory() }
        XCTAssertEqual(model.history.count, 180); XCTAssertEqual(model.history.first?.id, "record-90")
        XCTAssertEqual(model.history.last?.id, "record-269"); XCTAssertNotNil(model.historyNewerCursor)
        await model.loadMoreHistory(newer: true)
        XCTAssertEqual(model.history.count, 180); XCTAssertEqual(model.history.first?.id, "record-60")
        XCTAssertEqual(model.history.last?.id, "record-239")
        await model.loadMoreHistory()
        XCTAssertEqual(model.history.first?.id, "record-90"); XCTAssertEqual(model.history.last?.id, "record-269")
        XCTAssertEqual(Set(model.history.map(\.id)).count,180)
    }
    func testOlderWindowRefreshKeepsItsPositionAndReflectsRemoteDeletion() async throws {
        let (model, session, root) = try model()
        defer { model.stop(); session.invalidateAndCancel(); try? FileManager.default.removeItem(at: root) }
        await model.jumpHistory(to: "2026-09-10")
        let first = try XCTUnwrap(model.history.first?.id)
        XCTAssertNotEqual(first,"record-0")
        EchoHistoryProtocol.state.remove(first)
        await model.refreshHistory()
        XCTAssertFalse(model.history.contains { $0.id == first })
        XCTAssertFalse(model.history.contains { $0.id == "record-0" })
        XCTAssertEqual(model.historyBrowsingDate,"2026-09-10")
        XCTAssertEqual(model.history.count,29)
    }
    func testLateDateJumpCannotReplaceNewerSelectionAndCancelledRequestsStayQuiet() async throws {
        let (model, session, root) = try model()
        defer { model.stop(); session.invalidateAndCancel(); try? FileManager.default.removeItem(at: root) }
        EchoHistoryProtocol.state.hold()
        let slow = Task { await model.jumpHistory(to: "2026-09-10") }
        for _ in 0..<100 where !EchoHistoryProtocol.state.waiting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(EchoHistoryProtocol.state.waiting)
        await model.jumpHistory(to:"2026-09-20")
        let ids=model.history.map(\.id)
        EchoHistoryProtocol.state.release(); await slow.value
        XCTAssertEqual(model.historyBrowsingDate,"2026-09-20");XCTAssertEqual(model.history.map(\.id),ids)
        EchoHistoryProtocol.state.cancelNext()
        await model.loadMoreHistory()
        XCTAssertNil(model.historyError);XCTAssertFalse(model.historyLoading)
    }
    func testAccountSwitchFencesHistoryAndCalendarRequests() async throws {
        let (model, session, root) = try model()
        defer { model.stop(); session.invalidateAndCancel(); try? FileManager.default.removeItem(at: root) }
        EchoHistoryProtocol.state.hold()
        let pending = Task { await model.refreshHistory() }
        for _ in 0..<100 where !EchoHistoryProtocol.state.waiting { try await Task.sleep(for: .milliseconds(10)) }
        model.configure(scope:nil,client:nil)
        EchoHistoryProtocol.state.release();await pending.value
        XCTAssertTrue(model.history.isEmpty);XCTAssertFalse(model.historyLoaded);XCTAssertTrue(model.historyDays.isEmpty)
    }
}

@MainActor final class EchoTimelineTests: XCTestCase {
    private var session: URLSession!
    private var timeline: EchoTimelineModel!
    override func setUp() {
        EchoHistoryProtocol.state.reset()
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [EchoHistoryProtocol.self]
        session = URLSession(configuration: config)
        timeline = EchoTimelineModel()
        timeline.configure(scope: "alice", client: InstantClient(baseURL: URL(string: "https://echo-test.invalid")!, bearerToken: "test", session: session))
    }
    override func tearDown() { timeline.configure(scope: nil, client: nil); session.invalidateAndCancel() }
    private func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0..<200 { if condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
        XCTFail("Timeline did not settle")
    }
    func testEntireInventoryExistsBeforeAnyBodyLoadsAndDistantSeekSkipsInterveningPages() async throws {
        await timeline.refresh()
        XCTAssertEqual(timeline.days.flatMap(\.ids).count, 600); XCTAssertTrue(timeline.records.isEmpty)
        timeline.show(["record-550"])
        try await waitFor { self.timeline.records["record-550"] != nil }
        XCTAssertNil(timeline.records["record-0"])
        XCTAssertLessThanOrEqual(timeline.records.count, 37)
        XCTAssertEqual(timeline.days.flatMap(\.ids).count, 600)
    }
    func testEvictingTextLeavesEveryScrollPositionAndReturningRehydratesIt() async throws {
        await timeline.refresh()
        for position in stride(from: 0, through: 550, by: 50) {
            timeline.show(["record-\(position)"])
            try await waitFor { self.timeline.records["record-\(position)"] != nil }
            XCTAssertLessThanOrEqual(timeline.records.count, 180)
        }
        XCTAssertNil(timeline.records["record-0"])
        XCTAssertEqual(timeline.days.flatMap(\.ids).count, 600)
        timeline.show(["record-0"])
        try await waitFor { self.timeline.records["record-0"] != nil }
        XCTAssertEqual(timeline.days.flatMap(\.ids).first, "record-0")
    }
    func testDistantSeekWinsAgainstSlowLoadAndAccountChangeFencesResponses() async throws {
        await timeline.refresh()
        EchoHistoryProtocol.state.hold(); timeline.show(["record-0"])
        try await waitFor { EchoHistoryProtocol.state.waiting }
        timeline.show(["record-550"])
        try await waitFor { self.timeline.records["record-550"] != nil }
        EchoHistoryProtocol.state.release()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNil(timeline.records["record-0"])
        EchoHistoryProtocol.state.hold(); timeline.show(["record-200"])
        try await waitFor { EchoHistoryProtocol.state.waiting }
        timeline.configure(scope: nil, client: nil)
        EchoHistoryProtocol.state.release()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(timeline.records.isEmpty); XCTAssertTrue(timeline.days.isEmpty)
    }
    func testFailedBodiesRemainReachableAndRetryWithoutChangingPositions() async throws {
        await timeline.refresh()
        let ids = timeline.days.flatMap(\.ids)
        EchoHistoryProtocol.state.failNext(); timeline.show(["record-200"])
        try await waitFor { !self.timeline.failures.isEmpty }
        XCTAssertEqual(timeline.days.flatMap(\.ids), ids)
        timeline.retry()
        try await waitFor { self.timeline.records["record-200"] != nil }
        XCTAssertTrue(timeline.failures.isEmpty)
        EchoHistoryProtocol.state.remove("record-200")
        await timeline.refresh()
        XCTAssertNil(timeline.records["record-200"])
        XCTAssertEqual(timeline.days.flatMap(\.ids).count, 599)
    }
    func testDeletedRecordDuringHydrationIsRemovedAndSilenceDoesNotBlockFollowingRows() async throws {
        EchoHistoryProtocol.state.silenceFirst(90)
        await timeline.refresh()
        EchoHistoryProtocol.state.remove("record-0")
        timeline.show(["record-0", "record-1"])
        try await waitFor { self.timeline.records["record-1"] != nil }
        XCTAssertTrue(timeline.records["record-1"]!.isSilent)
        XCTAssertFalse(timeline.days.flatMap(\.ids).contains("record-0"))
        timeline.show(["record-100"])
        try await waitFor { self.timeline.records["record-100"] != nil }
        XCTAssertFalse(timeline.records["record-100"]!.isSilent)
    }
}

private final class EchoHistoryProtocol: URLProtocol, @unchecked Sendable {
    static let state = EchoHistoryFixture()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "echo-test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.state.respond(self) }
    override func stopLoading() {}
    func reply(_ data:Data) {
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:data);client?.urlProtocolDidFinishLoading(self)
    }
    func failReply() { client?.urlProtocol(self,didFailWithError:URLError(.notConnectedToInternet)) }
    func cancelReply() { client?.urlProtocol(self,didFailWithError:URLError(.cancelled)) }
}
private final class EchoHistoryFixture: @unchecked Sendable {
    private let lock=NSLock()
    private var deleted=Set<String>(), shouldHold=false, shouldCancel=false, shouldFail=false
    private var silentCount=0
    private var held:(EchoHistoryProtocol,Data)?
    var waiting:Bool { lock.withLock { held != nil } }
    func reset() { lock.withLock { deleted=[];shouldHold=false;shouldCancel=false;shouldFail=false;silentCount=0;held=nil } }
    func failNext() { lock.withLock { shouldFail=true } }
    func silenceFirst(_ count:Int) { lock.withLock { silentCount=count } }
    func remove(_ id:String) { _ = lock.withLock { deleted.insert(id) } }
    func hold() { lock.withLock { shouldHold=true } }
    func cancelNext() { lock.withLock { shouldCancel=true } }
    func release() { let value=lock.withLock { let v=held;held=nil;return v };if let value { value.0.reply(value.1) } }
    func respond(_ p:EchoHistoryProtocol) {
        var cancelled=false, failed=false
        let result:Data?=lock.withLock {
            if shouldFail { shouldFail=false;failed=true;return nil }
            if shouldCancel { shouldCancel=false;cancelled=true;return nil }
            let query=URLComponents(url:p.request.url!,resolvingAgainstBaseURL:false)!.queryItems ?? []
            func value(_ key:String)->String? { query.first { $0.name==key }?.value }
            let formatter=ISO8601DateFormatter(), origin=Date(timeIntervalSince1970:1790553600)
            let available=(0..<600).filter { !deleted.contains("record-\($0)") }
            func row(_ i:Int)->[String:Any] { ["id":"record-\(i)","clientSegmentId":"client-\(i)","startedAt":formatter.string(from:origin.addingTimeInterval(Double(-i*3600))),"endedAt":formatter.string(from:origin.addingTimeInterval(Double(-i*3600+30))),"status":"transcribed","transcript":i<silentCount ? "" : "Fixture \(i)","cursor":String(i)] }
            if p.request.url!.path.hasSuffix("/timeline") {
                var calendar=Calendar(identifier:.gregorian); calendar.timeZone=TimeZone(identifier:value("timeZone") ?? "UTC")!
                let groups=Dictionary(grouping:available) { i in
                    let c=calendar.dateComponents([.year,.month,.day],from:origin.addingTimeInterval(Double(-i*3600)))
                    return String(format:"%04d-%02d-%02d",c.year!,c.month!,c.day!)
                }
                return try! JSONSerialization.data(withJSONObject:["timeZone":value("timeZone") ?? "UTC","days":groups.keys.sorted(by:>).map { ["date":$0,"ids":groups[$0]!.map { "record-\($0)" }] }])
            }
            let ids=value("ids")?.split(separator:",").map(String.init)
            let before=value("before").flatMap { formatter.date(from:$0) }
            let cursor=value("cursor").flatMap(Int.init), newer=value("direction")=="newer", limit=value("limit").flatMap(Int.init) ?? 30
            var candidates=available.filter { i in
                if let ids { return ids.contains("record-\(i)") }
                if let cursor { return newer ? i<cursor : i>cursor }
                if let before { return origin.addingTimeInterval(Double(-i*3600))<before }
                return true
            }
            if newer { candidates.reverse() }
            var indexes=ids == nil ? Array(candidates.prefix(limit)) : candidates
            if newer { indexes.reverse() }
            let body:[String:Any]=["segments":indexes.map(row),"nextCursor":indexes.last.map { (newer || candidates.count>limit) ? String($0) as Any : NSNull() } ?? NSNull(),"previousCursor":indexes.first.map { (newer ? candidates.count>limit : cursor != nil || before != nil) ? String($0) as Any : NSNull() } ?? NSNull()]
            let data=try! JSONSerialization.data(withJSONObject:body)
            if shouldHold { shouldHold=false;held=(p,data);return nil }
            return data
        }
        if failed { p.failReply() } else if cancelled { p.cancelReply() } else if let result { p.reply(result) }
    }
}
