import Foundation

/// JSON-lines event channel back to Tucky (one object per line on the
/// ORIGINAL stdout). At startup we `dup` fd 1 for ourselves and point fd 1 at
/// stderr, so anything the libraries `print()` lands in Tucky's log instead of
/// corrupting the event stream.
final class EventSink: @unchecked Sendable {
    static let shared = EventSink()

    private let fd: Int32
    private let lock = NSLock()

    private init() {
        fd = dup(STDOUT_FILENO)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        setvbuf(stdout, nil, _IOLBF, 0)
        setvbuf(stderr, nil, _IOLBF, 0)
    }

    func emit(_ fields: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(fields),
              let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        else {
            FileHandle.standardError.write(Data("unserializable event: \(fields)\n".utf8))
            return
        }
        var line = data
        line.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        line.withUnsafeBytes { buf in
            guard let base = buf.baseAddress else { return }
            var off = 0
            while off < buf.count {
                let n = write(fd, base + off, buf.count - off)
                if n <= 0 { break }
                off += n
            }
        }
    }

    func log(_ level: String, _ msg: String) {
        emit(["event": "log", "level": level, "msg": msg])
    }

    func error(_ msg: String) {
        emit(["event": "error", "msg": msg])
    }
}

/// One-shot stop request shared by the signal handlers, the stdin watchdog and
/// the command runners. The first reason wins; the handler runs exactly once.
final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var reason: String?
    private var handler: (() -> Void)?

    func requestStop(_ why: String) {
        lock.lock()
        let first = reason == nil
        if first { reason = why }
        let cb = handler
        lock.unlock()
        if first {
            EventSink.shared.log("info", "stop requested: \(why)")
            cb?()
        }
    }

    /// Install the cancel callback; fires immediately if a stop already came in.
    func onStop(_ cb: @escaping () -> Void) {
        lock.lock()
        handler = cb
        let pending = reason
        lock.unlock()
        if pending != nil { cb() }
    }

    var stopReason: String? {
        lock.lock()
        defer { lock.unlock() }
        return reason
    }
}
