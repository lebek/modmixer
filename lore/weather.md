## Silence music from a GameCondition with `ForceFadeoutAndSilenceFor`, never `disabled = true`

```csharp
Find.MusicManagerPlay.ForceFadeoutAndSilenceFor(9999f, 5f, preventDangerTransition: true);
// to resume:
Find.MusicManagerPlay.ScheduleNewSong();
```

*Why it's tricky:* setting `MusicManagerPlay.disabled = true` looks like the obvious way to silence — but `MusicUpdate()` early-returns when `disabled` is true, so `UpdateFadeout()` never runs and the AudioSource just keeps playing whatever was already going. Pass `preventDangerTransition: true` or combat will override your silence.

## Snap weather instantly by assigning `curWeather` and `lastWeather` directly

```csharp
map.weatherManager.curWeather = WeatherDefOf.Clear;
map.weatherManager.lastWeather = WeatherDefOf.Clear;
```

Both fields are public. Do NOT use `TransitionTo(...)` — it starts a multi-hundred-tick lerp during which the old weather keeps rendering and obscures the new one.

*Why it's tricky:* `TransitionTo` is the only public-looking method for changing weather, but it's gradual. Direct assignment to both fields is instant and is what you want when scripting a weather change from code.
