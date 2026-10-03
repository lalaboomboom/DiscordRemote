/** Fixed, read-only Linux scanner. Request data is sent over stdin, never
 * interpolated into this program or the remote shell command. */
export const CODEX_EVENTS_SSH_PYTHON = String.raw`
import datetime, json, os, posixpath, re, stat, sys, time

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
RELATIVE = re.compile(r"^sessions/(\d{4})/(\d{2})/(\d{2})/rollout-\1-\2-\3T\d{2}-\d{2}-\d{2}-(" + UUID + r")\.jsonl$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$")
# Match JavaScript String.trim(), including BOM and its Unicode space separators.
TRIM = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
MAX_BYTES = 1024 * 1024
MAX_SIZE = 512 * 1024 * 1024
MAX_ENTRIES = 10000
DEADLINE = time.monotonic() + 5

def require(condition):
    if not condition:
        raise ValueError("Codex event metadata unavailable or unsafe.")

def check_time():
    require(time.monotonic() < DEADLINE)

def valid_cwd(value):
    return isinstance(value, str) and value.startswith("/") and len(value) <= 500 and not re.search(r"[\x00-\x1f\x7f]", value)

def normalized_cwd(value):
    return posixpath.normpath("/" + value.lstrip("/"))

def safe_integer(value):
    return type(value) in (int, float) and value == int(value) and abs(value) <= 9007199254740991

def valid_cursor(value):
    return isinstance(value, dict) and set(value) <= {"relativePath", "fileIdentity", "offset"} and isinstance(value.get("relativePath"), str) and RELATIVE.fullmatch(value["relativePath"]) and isinstance(value.get("fileIdentity"), str) and len(value["fileIdentity"]) <= 100 and re.fullmatch(r"\d+:\d+:\d+", value["fileIdentity"]) and safe_integer(value.get("offset")) and 0 <= value["offset"] <= MAX_SIZE

def timestamp(value):
    if safe_integer(value) and value > 0:
        result = int(value) * 1000 if value < 1000000000000 else int(value)
        require(result <= 8640000000000000)
        return result
    require(isinstance(value, str) and ISO.fullmatch(value))
    # fromisoformat accepts microseconds; millisecond normalization matches JS.
    parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    delta = parsed.astimezone(datetime.timezone.utc) - datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    result = delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000
    require(0 < result <= 8640000000000000)
    return result

def open_directory(parent, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)

def open_relative(home_fd, relative):
    parts = relative.split("/")
    parent = os.dup(home_fd)
    try:
        for part in parts[:-1]:
            child = open_directory(parent, part)
            os.close(parent)
            parent = child
        return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)

def discover(home_fd, thread):
    matches = []
    seen = 0
    def entries(fd):
        nonlocal seen
        result = []
        with os.scandir(fd) as directory:
            for entry in directory:
                check_time()
                seen += 1
                require(seen <= MAX_ENTRIES)
                result.append((entry.name, entry.is_dir(follow_symlinks=False), entry.is_file(follow_symlinks=False)))
        return sorted(result, reverse=True)
    sessions = open_directory(home_fd, "sessions")
    try:
        for year, is_dir, _ in entries(sessions):
            if not is_dir or not re.fullmatch(r"\d{4}", year):
                continue
            year_fd = open_directory(sessions, year)
            try:
                for month, is_dir, _ in entries(year_fd):
                    if not is_dir or not re.fullmatch(r"\d{2}", month):
                        continue
                    month_fd = open_directory(year_fd, month)
                    try:
                        for day, is_dir, _ in entries(month_fd):
                            if not is_dir or not re.fullmatch(r"\d{2}", day):
                                continue
                            day_fd = open_directory(month_fd, day)
                            try:
                                for name, _, is_file in entries(day_fd):
                                    relative = "/".join(("sessions", year, month, day, name))
                                    match = RELATIVE.fullmatch(relative)
                                    if match and match.group(4) == thread:
                                        require(is_file)
                                        matches.append(relative)
                            finally:
                                os.close(day_fd)
                    finally:
                        os.close(month_fd)
            finally:
                os.close(year_fd)
    finally:
        os.close(sessions)
    require(len(matches) == 1)
    return matches[0]

def scan(request):
    require(isinstance(request, dict) and set(request) <= {"threadId", "cwd", "cursor"} and isinstance(request.get("threadId"), str) and re.fullmatch(UUID, request["threadId"]) and valid_cwd(request.get("cwd")))
    cursor = request.get("cursor")
    require("cursor" not in request or valid_cursor(cursor))
    configured = os.environ.get("CODEX_HOME")
    home = configured if configured is not None else os.path.join(os.path.expanduser("~"), ".codex")
    require(posixpath.isabs(home))
    home = os.path.realpath(home)
    home_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        relative = cursor["relativePath"] if cursor is not None else discover(home_fd, request["threadId"])
        require(RELATIVE.fullmatch(relative).group(4) == request["threadId"])
        fd = open_relative(home_fd, relative)
    finally:
        os.close(home_fd)
    with os.fdopen(fd, "rb") as file:
        before = os.fstat(file.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_size <= MAX_SIZE)
        identity = str(before.st_dev) + ":" + str(before.st_ino) + ":0"
        first = file.readline(MAX_BYTES + 1)
        require(len(first) <= MAX_BYTES and first.endswith(b"\n"))
        meta = json.loads(first.decode("utf-8", errors="strict"))
        payload = meta.get("payload") if isinstance(meta, dict) else None
        require(meta.get("type") == "session_meta" and isinstance(payload, dict) and payload.get("id") == request["threadId"] and payload.get("source") == "cli" and valid_cwd(payload.get("cwd")) and normalized_cwd(payload["cwd"]) == normalized_cwd(request["cwd"]))
        events = []
        if cursor is None:
            offset = before.st_size
        else:
            offset = int(cursor["offset"])
            require(cursor["fileIdentity"] == identity and len(first) <= offset <= before.st_size)
            # Opting in during a partial line must not emit the old record.
            file.seek(offset - 1)
            partial = file.read(1) != b"\n"
            file.seek(offset)
            data = file.read(min(MAX_BYTES, before.st_size - offset))
            if partial:
                newline = data.find(b"\n")
                if newline == -1:
                    offset += len(data)
                    data = b""
                else:
                    offset += newline + 1
                    data = data[newline + 1:]
            position = 0
            while position < len(data):
                check_time()
                newline = data.find(b"\n", position)
                if newline == -1:
                    require(len(data) - position < MAX_BYTES)
                    break
                line = data[position:newline]
                position = newline + 1
                offset += len(line) + 1
                record = json.loads(line.decode("utf-8", errors="strict"))
                require(isinstance(record, dict))
                if record.get("type") != "event_msg":
                    continue
                payload = record.get("payload")
                require(isinstance(payload, dict) and isinstance(payload.get("type"), str))
                if payload["type"] != "task_complete":
                    continue
                require(isinstance(payload.get("turn_id"), str) and re.fullmatch(UUID, payload["turn_id"]))
                completed = payload["completed_at"] if "completed_at" in payload else record.get("timestamp")
                completed_at = timestamp(completed)
                message = payload.get("last_agent_message")
                require(message is None or isinstance(message, str))
                # Native completion with no final answer can mark an errored turn.
                # Never expose the private answer; only use its presence as a guard.
                if message is None or not message.strip(TRIM):
                    continue
                events.append({"turnId": payload["turn_id"], "completedAt": completed_at})
                if len(events) == 128:
                    break
        after = os.fstat(file.fileno())
        require(after.st_dev == before.st_dev and after.st_ino == before.st_ino and before.st_size <= after.st_size <= MAX_SIZE)
        # Verify the path still resolves to the same regular file after reading.
        current_home = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            current_fd = open_relative(current_home, relative)
        finally:
            os.close(current_home)
        try:
            current = os.fstat(current_fd)
            require(stat.S_ISREG(current.st_mode) and current.st_dev == before.st_dev and current.st_ino == before.st_ino and current.st_size >= offset)
        finally:
            os.close(current_fd)
        check_time()
        return {"threadId": request["threadId"], "cwd": request["cwd"], "cursor": {"relativePath": relative, "fileIdentity": identity, "offset": offset}, "events": events}

try:
    raw = sys.stdin.buffer.read(4097)
    require(len(raw) <= 4096)
    response = scan(json.loads(raw))
    sys.stdout.write(json.dumps(response, separators=(",", ":")))
except Exception:
    sys.stderr.write("Codex event metadata unavailable or unsafe.\n")
    sys.exit(1)
`;

export const CODEX_EVENTS_SSH_COMMAND = `python3 -c '${CODEX_EVENTS_SSH_PYTHON.replace(/'/g, "'\\''")}'`;
