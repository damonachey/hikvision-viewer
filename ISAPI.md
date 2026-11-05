# Hikvision ISAPI notes

What this project knows about the NVR's API, mainly for recordings and playback. It's a summary, not a replacement for Hikvision's guide.

## Sources and how far to trust them

- **Tested:** run against this project's NVR (a DS-7608N-E2/8P) in November 2026. Firmware version not recorded.
- **Guide:** described in *Intelligent Security API (General Application) Developer Guide* (2019). Not tried on this NVR, and the guide covers many device types, so it may not apply here.

The current official guides are on [Hikvision's partner portal](https://tpp.hikvision.com/tpp/ISAPI_Search). They need a login and a signed licence agreement, and a guide for this NVR's model may differ from the 2019 one.

## Basics

- ISAPI is HTTP with mostly XML bodies. Some newer endpoints take `?format=json`.
- Login is HTTP digest. Repeated failures lock the account, so stop after one rejected password.
- Track and stream IDs are the channel number × 100, plus the stream type: `1` main, `2` secondary, `3` third. `101` is channel 1's main stream.

## Limits reported by this NVR

From `GET /ISAPI/ContentMgmt/search/profile` (tested):

| Limit | Value | Meaning |
|---|---|---|
| `maxConcurrentSearches` | 1 | Send searches one at a time |
| `maxSearchMatchResults` | 64 | Most results in one response |
| `maxSearchTracks` | 16 | Most tracks in one search |
| `maxSearchTimespans` | 1 | One time range per search |

## Finding recordings

| Request | Purpose | Status |
|---|---|---|
| `POST /ISAPI/ContentMgmt/search` | Recordings in a time range | Tested |
| `POST /ISAPI/ContentMgmt/record/tracks/<id>/dailyDistribution` | Days in a month with video | Tested |
| `GET /ISAPI/ContentMgmt/search/profile` | Search limits | Tested |
| `GET /ISAPI/ContentMgmt/record/tracks/<id>` | A track's recording settings and schedule | Tested |
| `GET /ISAPI/ContentMgmt/record/profile` | Track types | Tested |
| `POST /ISAPI/ContentMgmt/SmartSearch` | Search by detected events | Guide |
| `POST /ISAPI/SDT/Management/IntelligentSearch?format=json` | Search for people, vehicles and so on, on devices that support it | Guide |

### Search

```xml
<CMSearchDescription>
  <searchID>any-new-uuid</searchID>
  <trackList><trackID>101</trackID><trackID>201</trackID></trackList>
  <timeSpanList><timeSpan>
    <startTime>2026-11-03T00:00:00Z</startTime>
    <endTime>2026-11-03T23:59:59Z</endTime>
  </timeSpan></timeSpanList>
  <maxResults>64</maxResults>
  <searchResultPostion>0</searchResultPostion>
  <metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>
```

Tested behaviour:

- `responseStatusStrg` is `MORE` when more results exist and `NO MATCHES` when there are none. Page through by raising `searchResultPostion`.
- For one track, results come back oldest first. Across tracks, the order isn't confirmed.
- Several tracks work in one search.
- Each result has a start and end time, codec, record type and `playbackURI`.
- Secondary tracks such as `102` return HTTP 400.

Oddities:

- `searchResultPostion` is misspelled in both the guide and the NVR's API. Keep the misspelling.
- The guide's example uses `trackIDList`, while this project sends `trackList`, which this NVR honours.

### Days with video

```xml
<trackDailyParam><year>2026</year><monthOfYear>11</monthOfYear></trackDailyParam>
```

Returns each day with a `record` value of `true` or `false`. It doesn't distinguish streams: tested on this NVR, `102` and even the non-existent `103` report the same days as `101`.

## Time zones

Times are written with a `Z`, but on this NVR they're local time. A frame requested for `15:39:27Z` showed `15:39:26` on the camera's local on-screen clock (tested). Don't convert them. The times listed for a clip can also be a few seconds off from its video (tested).

## Playback

```
rtsp://<user>:<password>@<nvr>:554/Streaming/tracks/101?starttime=20261103T153927Z&endtime=20261103T154027Z
```

- **Tested:** FFmpeg plays this at normal speed, and a frame arrives within a second of the requested time. It also accepts a range spanning several recordings.
- **Tested:** use no slash before `?`. The address in search results has one, and using it unchanged made the NVR answer FFmpeg's `SETUP` with a 401, which could count toward an account lockout. The guide's examples put the track control after the query string, which may be related.
- **Tested:** only one recording can play at a time, and a second gets `453 Not Enough Bandwidth`. Live streams and downloads can still run alongside it. The slot can stay busy for several seconds after a stream ends, and it once stayed stuck until the NVR was rebooted.
- **Tested:** `/Streaming/tracks/102` returns HTTP 400, and `record/tracks/102` returns 403, so this NVR appears to record only main streams.
- **Guide:** the guide's own path is `/ISAPI/Streaming/tracks/<id>`, with `endtime` optional. Without it, the stream runs until the session ends.
- **Guide:** a session supports RTSP `PAUSE`, `Range: clock=...` and `Scale` for faster playback, with 2× and 4× in the examples. Seeking within an open session could be faster than reconnecting, but it's untested. FFmpeg's command line doesn't control this.
- **Guide:** `PUT /ISAPI/ContentMgmt/record/control/manualRefresh/channels/<id>` refreshes the video index for instant playback.

## Pictures and thumbnails

**The guide has no call that returns a frame from a past time.**

| Request | What it does | Status |
|---|---|---|
| `GET /ISAPI/Streaming/channels/<id>/picture` | Current JPEG. Optional `videoResolutionWidth` and `videoResolutionHeight`. The guide documents no time parameter and says main stream only. | Tested |
| `POST /ISAPI/ContentMgmt/search` on a picture track (`103`) | Community code uses `+3` for stored pictures. The guide calls `3` the third stream. On this NVR it returns HTTP 403. | Tested |
| `pictureSearchType` | This NVR lists only `vehicleDetection`, so it looks limited to event pictures. | Tested |

Two methods work (tested). Both keep the first frame and hang up:

- **From a download:** only gives the frame at the start of a file, but it doesn't need the one playback slot. This project uses it for thumbnails.
- **From playback:** works for any time, but needs the playback slot. It takes about 1.9 seconds per frame on a quiet NVR, or about 0.65 seconds with FFmpeg's `-probesize 32768 -analyzeduration 0`. `-fflags nobuffer` timed out.

After an NVR reboot, `picture` returned HTTP 500 for over 12 minutes, then recovered with no change (tested).

Also, `isSupportSnapshot` reports `false` on this NVR even though snapshots work, so don't rely on the capability lists alone.

## Downloading

`GET /ISAPI/ContentMgmt/download`, with a `downloadRequest` body holding a search result's `playbackURI`, returns the file:

```xml
<downloadRequest version="1.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
  <playbackURI>rtsp://<nvr>/Streaming/tracks/101?starttime=...&amp;endtime=...&amp;name=...&amp;size=...</playbackURI>
</downloadRequest>
```

Tested behaviour:

- It's a `GET` with a body, as in the guide's reference. Community code uses `POST`.
- It only returns a whole named file from its start. Range and time requests are ignored or rejected, but hanging up early works, so the start of a file is quick to get.
- The format is MPEG-PS.
- Speed is about 70–80 Mbit/s for one download, and about 93 Mbit/s in total for three at once.
- Downloads can overlap playback and live streams.
- `GET /ISAPI/ContentMgmt/download/capabilities` returns HTTP 400 even though downloads work.
- A clip's first bytes arrive in about 25 ms. FFmpeg can copy the video into fragmented MP4 as it arrives, at about 11× normal speed for 4 Mbit/s video. This project uses that for playback above 1×, reading past the unwanted part to start mid-clip.
- A clip's video can run a few seconds longer than its listed times, such as 18.8 seconds for a clip listed as 16.
- Downloads of consecutive clips can be fed into one FFmpeg as one MPEG-PS stream. Their timestamps follow real time across the gaps between clips, and FFmpeg closes those gaps unless told otherwise with `-dts_delta_threshold`.
- The NVR can drop a long download partway. One 1016 MiB file stopped at about 590 MiB and about 690 MiB on two tries, and another finished in 227 seconds. The cause is unknown.

## Motion detection

| Request | Purpose | Status |
|---|---|---|
| `GET /ISAPI/ContentMgmt/InputProxy/channels/<id>/video/motionDetection`, and the same with `/layout` | A camera's motion settings, including sensitivity and the grid of watched cells | Tested |
| `GET /ISAPI/System/Video/inputs/channels/<id>/motionDetection` | Returns an error on this NVR, so use the addresses above | Tested |

Sensitivity is 1–5 on the NVR, and 3 shows as 60 on the camera. Changes made through the NVR reached Cameras 1–5 (tested).

## NVR and camera settings

All tested:

- The NVR's readings of a camera's main-stream settings can disagree with the camera. The camera's settings are the ones it records with.
- Quality uses different scales: 20, 30, 45, 60, 75, 90 on the NVR, and 1, 20, 40, 60, 80, 100 on the camera.
- Cameras on firmware V5.3.6 refused stream setting changes with `500 Device Error`, even from the camera's own web page.

## Other useful read-only calls

| Request | Purpose | Status |
|---|---|---|
| `GET /ISAPI/ContentMgmt/InputProxy/channels` | Camera list | Tested |
| `GET /ISAPI/ContentMgmt/InputProxy/channels/status` | Which cameras are online | Tested |
| `GET /ISAPI/Streaming/channels/<id>` | A stream's resolution, bitrate and codec | Tested |
| `GET /ISAPI/ContentMgmt/capabilities` | Storage and channel features | Tested |
| `GET /ISAPI/System/capabilities` | Device features | Tested |
| `GET /ISAPI/ContentMgmt/Storage/hdd` | Disks, which could help estimate how long footage lasts | Guide |

## Don't call these casually

These change the NVR or its recordings. They're listed so they aren't mistaken for read-only calls.

- `PUT /ISAPI/ContentMgmt/Storage/hdd/format` and `.../hdd/<id>/format` format disks
- `PUT` or `POST /ISAPI/ContentMgmt/record/tracks` changes recording schedules
- `POST /ISAPI/ContentMgmt/record/control/manual/start/tracks/<id>` and `.../stop/...` control recording
- `/ISAPI/ContentMgmt/InputProxy/channels/<id>/reboot` reboots a camera

## Links

- [Hikvision ISAPI developer guides](https://tpp.hikvision.com/tpp/ISAPI_Search) (needs a login and licence agreement)
- [`hikvision_client` source](https://hex.pm/packages/hikvision_client/0.1.1/files/lib/hikvision/content_management.ex), a community client showing search and download
