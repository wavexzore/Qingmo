// Real-Tauri measurement helper for T-017.
//
// It drives the native open panel through Accessibility, presses Open, polls
// for the status bar as an upper bound on open time, focuses the editor, types
// one character, presses Cmd+S and polls for "已同步" as a save upper bound.
//
// This is not a framework; run it only on macOS with Accessibility permission:
//   swift bench/tauri/measure.swift <pid> <filename-in-cwd> [timeout-seconds]

import ApplicationServices
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 3, let pid = pid_t(arguments[1]) else {
    fputs("usage: measure.swift <pid> <filename> [timeout]\n", stderr)
    exit(2)
}
let target = arguments[2]
let timeout = arguments.count >= 4 ? (Double(arguments[3]) ?? 60) : 60
let app = AXUIElementCreateApplication(pid)

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return error == .success ? value : nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func role(_ element: AXUIElement) -> String {
    (attribute(element, kAXRoleAttribute as String) as? String) ?? ""
}

func title(_ element: AXUIElement) -> String {
    (attribute(element, kAXTitleAttribute as String) as? String) ?? ""
}

func description(_ element: AXUIElement) -> String {
    (attribute(element, kAXDescriptionAttribute as String) as? String) ?? ""
}

func identifier(_ element: AXUIElement) -> String {
    (attribute(element, kAXIdentifierAttribute as String) as? String) ?? ""
}

func stringValue(_ element: AXUIElement) -> String {
    (attribute(element, kAXValueAttribute as String) as? String) ?? ""
}

func isEnabled(_ element: AXUIElement) -> Bool {
    if let number = attribute(element, kAXEnabledAttribute as String) as? NSNumber {
        return number.boolValue
    }
    return false
}

func parent(_ element: AXUIElement) -> AXUIElement? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value)
    return error == .success ? (value as! AXUIElement?) : nil
}

func find(
    _ element: AXUIElement,
    depth: Int = 0,
    maxDepth: Int = 12,
    where predicate: (AXUIElement) -> Bool
) -> AXUIElement? {
    if predicate(element) {
        return element
    }
    if depth >= maxDepth {
        return nil
    }
    for child in children(element) {
        if let match = find(child, depth: depth + 1, maxDepth: maxDepth, where: predicate) {
            return match
        }
    }
    return nil
}

func statusText() -> String {
    let markers = ["已同步", "等待保存", "保存中", "保存失败", "只读"]
    guard
        let text = find(app, maxDepth: 8, where: { element in
            role(element) == "AXStaticText" && markers.contains(where: { stringValue(element).contains($0) })
        })
    else {
        return ""
    }
    return stringValue(text)
}

func hasStaticText(_ marker: String) -> Bool {
    find(app, maxDepth: 8, where: { element in
        role(element) == "AXStaticText" && stringValue(element).contains(marker)
    }) != nil
}

func documentHeading() -> String {
    guard
        let heading = find(app, maxDepth: 8, where: { element in
            role(element) == "AXHeading" && !title(element).isEmpty
        })
    else {
        return ""
    }
    return title(heading)
}

func hasEditor() -> Bool {
    find(app, maxDepth: 10, where: { role($0) == "AXTextArea" }) != nil
}

func rssMb() -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-o", "rss=", "-p", String(pid)]
    let pipe = Pipe()
    process.standardOutput = pipe
    try? process.run()
    process.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let kib = Double(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) else {
        return "null"
    }
    return String(format: "%.1f", kib / 1024.0)
}

func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
    guard let source = CGEventSource(stateID: .hidSystemState) else { return }
    let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
    down?.flags = flags
    down?.postToPid(pid)
    usleep(12_000)
    let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
    up?.flags = flags
    up?.postToPid(pid)
}

func waitUntil(_ seconds: Double, _ predicate: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if predicate() {
            return true
        }
        usleep(10_000)
    }
    return predicate()
}

// 1. Ensure the open panel is visible.
if find(app, maxDepth: 5, where: { role($0) == "AXSheet" }) == nil {
    for _ in 0..<2 {
        postKey(31, flags: .maskCommand) // Cmd+O
        if waitUntil(8, { find(app, maxDepth: 5, where: { role($0) == "AXSheet" }) != nil }) {
            break
        }
    }
    guard find(app, maxDepth: 5, where: { role($0) == "AXSheet" }) != nil else {
        fputs("open panel did not appear\n", stderr)
        exit(3)
    }
}

guard let sheet = find(app, maxDepth: 5, where: { role($0) == "AXSheet" }) else {
    fputs("open panel not found\n", stderr)
    exit(3)
}

var targetField: AXUIElement?
guard waitUntil(5, {
    let currentSheet = find(app, maxDepth: 5, where: { role($0) == "AXSheet" }) ?? sheet
    targetField = find(currentSheet, where: { role($0) == "AXTextField" && stringValue($0) == target })
    return targetField != nil
}), let field = targetField, let row = {
        var current: AXUIElement? = field
        for _ in 0..<5 {
            guard let candidate = current else { return nil as AXUIElement? }
            if role(candidate) == "AXRow" {
                return candidate
            }
            current = parent(candidate)
        }
        return nil as AXUIElement?
    }()
else {
    fputs("file row not found: \(target)\n", stderr)
    exit(4)
}

AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
_ = AXUIElementSetAttributeValue(row, kAXFocusedAttribute as CFString, kCFBooleanTrue)
usleep(150_000)

func isOpenButton(_ element: AXUIElement) -> Bool {
    guard role(element) == "AXButton" else { return false }
    return title(element) == "Open" || description(element) == "Open" || identifier(element) == "OKButton"
}

var openButton: AXUIElement?
guard waitUntil(6, {
    let currentSheet = find(app, maxDepth: 5, where: { role($0) == "AXSheet" }) ?? sheet
    openButton = find(currentSheet, maxDepth: 16, where: { isOpenButton($0) && isEnabled($0) })
    return openButton != nil
}), let openButton else {
    fputs("Open button not found or disabled\n", stderr)
    exit(5)
}

let openStart = Date()
let openError = AXUIElementPerformAction(openButton, kAXPressAction as CFString)
if openError != .success {
    fputs("Open press failed: \(openError.rawValue)\n", stderr)
    exit(6)
}

// 2. The target heading only exists once the new document session is mounted.
// The status bar alone is not enough: an already-open document keeps its status
// bar visible while the dialog is open.
guard waitUntil(timeout, { documentHeading() == target && statusText() != "" && hasEditor() }) else {
    fputs("document did not open before timeout; heading=\(documentHeading())\n", stderr)
    exit(7)
}
let openMs = Date().timeIntervalSince(openStart) * 1000

// Let the editor finish its first frame before typing; this is outside the
// measured open window.
usleep(250_000)
let baseline = statusText()

// 3. Focus the CM6 text area. The 10 MiB fixture is exactly at the save
// limit, so inserting would be rejected; delete one character instead.
let largeFile = hasStaticText("大文档") || hasStaticText("源码")
let editor = find(app, maxDepth: 12, where: { role($0) == "AXTextArea" })
if let editor {
    let focusError = AXUIElementSetAttributeValue(editor, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if focusError != .success {
        _ = AXUIElementPerformAction(editor, kAXPressAction as CFString)
    }
    usleep(40_000)
}
postKey(largeFile ? 117 : 6) // forward delete for 10 MiB, otherwise z

let dirty = waitUntil(1.5, { statusText() != baseline && !statusText().isEmpty })
let beforeSave = statusText()
let saveStart = Date()
postKey(1, flags: .maskCommand) // Cmd+S

let saved = waitUntil(10, { statusText().contains("已同步") })
let saveMs = saved ? Date().timeIntervalSince(saveStart) * 1000 : -1
let finalStatus = statusText()

print("open_ms=\(String(format: "%.1f", openMs))")
print("save_ms=\(saved ? String(format: "%.1f", saveMs) : "null")")
print("rss_mb=\(rssMb())")
print("dirty_seen=\(dirty)")
print("status_before_save=\(beforeSave)")
print("status_after_save=\(finalStatus)")
print("live_preview=\(largeFile ? "false" : "true")")
