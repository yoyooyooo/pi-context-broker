"""Small VT screen for Pi PTY evidence; scrollback is deliberately excluded."""
import codecs
import re
import unicodedata


class TerminalScreen:
    def __init__(self, rows=40, columns=140):
        self.rows, self.columns = rows, columns
        self.cells = [[' '] * columns for _ in range(rows)]
        self.row = self.column = 0
        self.saved = (0, 0)
        self.pending = ''
        self.decoder = codecs.getincrementaldecoder('utf-8')()
        self.synchronized = False
        self.unsupported = set()

    def feed(self, data):
        text = self.pending + self.decoder.decode(data)
        self.pending = ''
        index = 0
        while index < len(text):
            char = text[index]
            if char == '\x1b':
                rest = text[index:]
                if len(rest) < 2:
                    self.pending = rest
                    break
                if rest[1] == '[':
                    match = re.match(r'\x1b\[([0-?]*)([ -/]*)([@-~])', rest)
                    if not match:
                        self.pending = rest
                        break
                    self.csi(*match.groups())
                    index += len(match.group())
                    continue
                if rest[1] in ']P_^':
                    match = re.search(r'\x07|\x1b\\', rest[2:])
                    if not match:
                        self.pending = rest
                        break
                    index += 2 + match.end()
                    continue
                if rest[1] == '7':
                    self.saved = (self.row, self.column)
                elif rest[1] == '8':
                    self.row, self.column = self.saved
                elif rest[1] not in '=>':
                    self.unsupported.add(repr(rest[:2]))
                index += 2
                continue
            if char == '\r':
                self.column = 0
            elif char == '\n':
                self.down()
            elif char == '\b':
                self.column = max(0, self.column - 1)
            elif char == '\t':
                self.column = min(self.columns - 1, (self.column // 8 + 1) * 8)
            elif ord(char) >= 32 and char != '\x7f':
                if not unicodedata.combining(char):
                    width = 2 if unicodedata.east_asian_width(char) in ('W', 'F') else 1
                    if self.column + width > self.columns:
                        self.column = 0
                        self.down()
                    self.cells[self.row][self.column] = char
                    if width == 2:
                        self.cells[self.row][self.column + 1] = ''
                    self.column += width
            index += 1

    def down(self):
        self.row += 1
        if self.row >= self.rows:
            self.cells.pop(0)
            self.cells.append([' '] * self.columns)
            self.row = self.rows - 1

    def csi(self, parameters, intermediate, final):
        private = parameters.startswith(('?', '>', '<', '='))
        values = [int(value or 0) for value in parameters.lstrip('?<>=').split(';')]
        n = values[0] or 1
        if final in ('m', 'c', 'n') or final == 'u' and private:
            return
        if final in ('h', 'l') and private:
            if 2026 in values:
                self.synchronized = final == 'h'
            return
        if final == 'n':
            return
        if final == 'A':
            self.row = max(0, self.row - n)
        elif final == 'B':
            self.row = min(self.rows - 1, self.row + n)
        elif final == 'C':
            self.column = min(self.columns - 1, self.column + n)
        elif final == 'D':
            self.column = max(0, self.column - n)
        elif final in ('G', '`'):
            self.column = min(self.columns - 1, n - 1)
        elif final in ('H', 'f'):
            self.row = min(self.rows - 1, n - 1)
            self.column = min(self.columns - 1, (values[1] or 1) - 1) if len(values) > 1 else 0
        elif final == 'K':
            start = 0 if values[0] in (1, 2) else min(self.column, self.columns)
            end = min(self.column + 1, self.columns) if values[0] == 1 else self.columns
            self.cells[self.row][start:end] = [' '] * (end - start)
        elif final == 'J':
            if values[0] in (2, 3):
                self.cells = [[' '] * self.columns for _ in range(self.rows)]
            elif values[0] == 0:
                self.cells[self.row][self.column:] = [' '] * (self.columns - self.column)
                for row in range(self.row + 1, self.rows):
                    self.cells[row] = [' '] * self.columns
            else:
                self.unsupported.add('CSI ' + parameters + final)
        elif final == 's':
            self.saved = (self.row, self.column)
        elif final == 'u':
            self.row, self.column = self.saved
        else:
            self.unsupported.add('CSI ' + parameters + intermediate + final)

    def snapshot(self):
        lines = [''.join(row).rstrip() for row in self.cells]
        borders = [index for index, line in enumerate(lines) if re.fullmatch(r'[─━]{10,}', line)]
        editor = None
        candidate = None
        editor_rows = None
        for upper, lower in zip(borders, borders[1:]):
            if lower == upper + 2:
                editor = lines[upper + 1].strip()
                editor_rows = [upper + 1, lower + 1]
                candidate = lines[lower + 1].strip() if lower + 1 < len(lines) else ''
        return {'lines': lines, 'cursor': [self.row, self.column], 'editor': editor,
                'candidate': candidate, 'editorRows': editor_rows,
                'complete': not self.pending and not self.decoder.getstate()[0] and not self.synchronized and not self.unsupported,
                'unsupported': sorted(self.unsupported)}


def matches(screen, expected):
    state = screen.snapshot()
    if not state['complete'] or state['editor'] is None:
        return False
    stage = expected['stage']
    if stage == 'ready':
        lines = state['lines'][:state['editorRows'][0] - 1]
        try:
            skills = lines.index('[Skills]')
            extensions = lines.index('[Extensions]', skills + 1)
        except ValueError:
            return False
        return (state['editor'] == '' and expected['skill'] in
                [line.strip() for line in lines[skills + 1:extensions]] and
                any(line.strip() for line in lines[extensions + 1:]) and
                any(re.search(r'\bfake\s*$', line) for line in state['lines']))
    if stage == 'candidate':
        candidate = state['candidate'] or ''
        return state['editor'] == expected['prefix'] and bool(re.match(
            r'^→\s+' + re.escape(expected['selected']) + r'(?=\s|$)', candidate))
    if stage == 'draft':
        return state['editor'] == expected['token'] and not (state['candidate'] or '').startswith('→')
    if stage == 'submitted':
        return state['editor'] == '' and any(line.strip() == 'OK' for line in state['lines'])
    raise ValueError('Unknown screen stage: ' + stage)
