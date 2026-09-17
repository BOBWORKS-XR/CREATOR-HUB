# Generated Media Fixtures

`demo.gif` and `demo.webm` are one-second 64x48 test patterns generated locally:

```sh
ffmpeg -f lavfi -i testsrc=size=64x48:rate=2 -t 1 demo.gif
ffmpeg -f lavfi -i testsrc=size=64x48:rate=2 -t 1 -c:v libvpx-vp9 -pix_fmt yuv420p demo.webm
```

They are test assets, not catalogue submissions or contributor work.
