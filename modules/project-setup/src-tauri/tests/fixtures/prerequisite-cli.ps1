# Local child-process fixture: no downloads, installs, account or project access.
$mode = $args[0]
switch ($mode) {
    'query' {
        [Console]::Error.WriteLine('Dependency diagnostic separate from JSON')
        [Console]::Out.WriteLine('{"success":true,"data":{"totalDownloadSize":1234}}')
    }
    'bad-json' { [Console]::Out.WriteLine('not a JSON report') }
    'false-result' {
        [Console]::Out.WriteLine('{"type":"result","success":false}')
    }
    'offline' { exit 7 }
    'configuration' { exit 4 }
    'auth' { exit 3 }
    'progress' {
        [Console]::Out.WriteLine('{"type":"progress","phase":"download","msg":"Downloading Android Build Support...","pct":42}')
        [Console]::Out.WriteLine('{"type":"progress","phase":"install","name":"Android","pct":50}')
        [Console]::Out.WriteLine('{"type":"result","success":true}')
    }
    'stream-progress' {
        $file = [IO.File]::Open($args[1], [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            [Console]::Out.WriteLine('{"type":"progress","phase":"download","msg":"Downloading OpenJDK...","pct":8}')
            $buffer = New-Object byte[] 65536
            for ($i = 0; $i -lt 20; $i++) { $file.Write($buffer, 0, $buffer.Length); Start-Sleep -Milliseconds 250 }
        } finally { $file.Dispose() }
        [Console]::Out.WriteLine('{"type":"progress","phase":"install","name":"OpenJDK","pct":8}')
        [Console]::Out.WriteLine('{"type":"result","success":true}')
    }
    default { exit 2 }
}
exit 0
