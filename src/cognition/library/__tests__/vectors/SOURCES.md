# Where the vectors come from

`meeting.srt`, `meeting.vtt`, `otter.txt`, `fireflies.json` and `lines.txt` are written for these tests: one meeting of six turns in each layout.

`otter-names-times.txt`, `otter-times.txt` and `otter-names.txt` are real exports from Otter, published under open licences. Each is cut from its source as the table says; the lines kept are byte for byte the source's, the spaces at their ends included. They are test data and are not part of the published package.

| Vector | Source | Licence | Lines kept |
|---|---|---|---|
| `otter-names-times.txt` | "Pick N Mix 10 APIs" transcription, Open Data Manchester, [training-and-resources at dff58e0b](https://github.com/OpenDataManchester/training-and-resources/blob/dff58e0b4e2897be10e72fa958a8ac209243e9c3/Pick-N-Mix/APIs/200714%20Pick%20N%20Mix%2010%20APIs%20Transcription.txt) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 31 to 43: the last four turns and the closing line |
| `otter-times.txt` | `error-analysis-01.txt`, [uwplse/seguard-resources at 56000901](https://github.com/uwplse/seguard-resources/blob/56000901d477bcabf80dc112524ad8fc93cb2a9e/files/transcript/error-analysis-01.txt) | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) | 1 to 15 and 28: the first five turns and the closing line |
| `otter-names.txt` | "Pick N Mix 3 an introduction to the UK Data Service" transcription, Open Data Manchester, [training-and-resources at 0a3ce68d](https://github.com/OpenDataManchester/training-and-resources/blob/0a3ce68d725f20cb2f0b34bdb15a51b81c747c7f/Pick-N-Mix/UK%20Data%20Service/Pick%20N%20Mix%203%20an%20introduction%20to%20the%20UK%20Data%20Service%20Transcription.txt) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 7 to 21 and 55: five turns and the closing line |

Otter's export has two options, the speakers' names and the times, and each file shows one of its layouts:

- `otter-names-times.txt`: names and times. A header is the name, two spaces, the time and two spaces: `Sam  1:04:46  `.
- `otter-times.txt`: times alone. A header is the time and two spaces: `0:04  `.
- `otter-names.txt`: names alone. A header is the name and two spaces: `Sam  `. A paragraph line ends with one space at most.

An export made with neither option holds its paragraphs and its closing line alone.

`otter-names-times-one-space.txt` is written for these tests in the layout of the export Otter makes of a voice note, since no such export was found under an open licence. That export writes each header as the speaker's name, one space and the time, with nothing after it (`Unknown 0:03`), ends no line with a space, and has no line feed after its closing line, as public files show it: for one, `My tutorial recording_otter.ai.txt` in [philsgu/myfoo_python at 8a5ebfe2](https://github.com/philsgu/myfoo_python/blob/8a5ebfe20fb4f2f1ff3648df0e728327d5d7ceca/My%20tutorial%20recording_otter.ai.txt). The vector's words are its own; none is copied from such a file.
