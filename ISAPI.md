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
  <maxResults>40</maxResults>
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

Times are written with a `Z`, but on this NVR they're local time. A frame requested for `15:39:27Z` showed `15:39:26` on the camera's local on-screen clock (tested). Don't convert them.

## Playback

```
rtsp://<user>:<password>@<nvr>:554/Streaming/tracks/101?starttime=20261103T153927Z&endtime=20261103T154027Z
```

- **Tested:** FFmpeg plays this at normal speed, and a frame arrives within a second of the requested time. It also accepts a range spanning several recordings.
- **Tested:** use no slash before `?`. The address in search results has one, and using it unchanged made the NVR answer FFmpeg's `SETUP` with a 401, which could count toward an account lockout. The guide's examples put the track control after the query string, which may be related.
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

The working method (tested) is to open playback with FFmpeg, keep the first frame and disconnect. It takes about 1.9 seconds per frame on a quiet NVR.

Also, `isSupportSnapshot` reports `false` on this NVR even though snapshots work, so don't rely on the capability lists alone.

## Downloading

- **Guide:** `GET /ISAPI/ContentMgmt/download`, with a `downloadRequest` body holding a `playbackURI`, returns a file.
  ```xml
  <downloadRequest version="1.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <playbackURI>rtsp://<nvr>/Streaming/tracks/101?starttime=...&amp;endtime=...&amp;name=...&amp;size=...</playbackURI>
  </downloadRequest>
  ```
  Include `name` and `size` to download by file, or only the times to download by time. The guide's reference shows `GET`, but community code uses `POST`.
- **Tested:** `GET /ISAPI/ContentMgmt/download/capabilities` returned HTTP 400 on this NVR, so support is unconfirmed. Forum users report errors from this endpoint too.
- **Untested:** whether a download is faster than playback, or what file format it returns. Downloading could be a faster way to fetch clips, but each file can be large.

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
