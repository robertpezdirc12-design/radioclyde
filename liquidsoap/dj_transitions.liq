# dj_transitions.liq — DJ transition effects (P3 #11, roadmap row 11)
#
# Sweep / washout / dissolve track transitions for the music program, behind
# the P3 #11 Liquidsoap upgrade (2.2.4-1+dev -> 2.4.6). The whole file is
# wrapped in a preprocessor gate: on the OLD box build (2.2.4) every line
# below is stripped BEFORE parsing, so radio.liq boots byte-identically to
# pre-#11 even though this file is %included unconditionally. The %include
# is deliberately NOT nested inside radio.liq's own %ifversion blocks --
# both builds' preprocessor handles %ifversion/%include in the same pass
# (verified: tests/language/pp.liq in both the 2.2.4 and 2.4.6 tars), but
# keeping nesting out of the picture removes a whole class of uncertainty.
#
# Provenance: the three effects are borrowed from SUB/WAVE's production
# radio.liq (perminder-klair/subwave v1.27.0, MIT, analyzed in docs/
# subwave-deep-analysis.md) -- the transition machinery they run on air,
# scaled back to the three effects our roadmap names. Every constant below
# (envelope breakpoints, filter cutoffs, comb delays, makeup gains) is
# THEIR measured value, kept verbatim: they were tuned on air against the
# same Liquidsoap 2.4.x engine we are upgrading to, and re-tuning blind
# would throw away that work. Deviations from SUB/WAVE are listed under
# DEVIATIONS below and are all about OUR station's contract, not the math.
#
# Engine constraints, all measured by SUB/WAVE on air -- do not "simplify"
# past them:
#   * 2.4.6 is the MINIMUM runtime for the effects: 2.4.4's O(n) clock scan
#     pegs a core on every effect transition, and 2.4.5 drops a partial
#     frame after every `cross` (both fixed in 2.4.6; this is why the gate
#     is >= 2.4.6 and not >= 2.4.0). Our own 2.2.4 additionally has the
#     live-confirmed fade.out whole-track bug (2026-07-29) -- irrelevant
#     here because this file never parses there, and 2.4.6 also fixed the
#     upstream fade.out bugs we hit (#5514 + the liq_fade_*_delay
#     infinity fix in the 2.4.6 changelog).
#   * `comb`, NOT `echo`: native echo (incl. ping_pong) type-checks then
#     passes audio through bit-for-bit on the builds SUB/WAVE measured.
#   * `filter.rc`, NOT the SVF `filter` (unstable near sr/4, collapses to
#     near-silence -- hence the 9 kHz cap on every "open" cutoff) and NOT
#     iir_filter/HPF ("Early computation of source content-type" crash).
#   * filter.rc mode="high" is BROKEN (a static 400 Hz HPF collapses music
#     to -115 dB; 40 Hz on a 440 Hz tone renders -inf) -- high-pass is
#     built as dry - lowpass(dry) where needed (the sweep bass swap).
#   * Every envelope is a closure over source.elapsed() on its own branch,
#     so it holds in AUDIO time under any clock (wall-clock envelopes
#     drift).
#   * An amplify getter is read once per ~20 ms frame, so envelope edges
#     land on frame boundaries; the smoothsteps shape WHICH frames open,
#     not sub-frame audio.
#   * Performance shape (#1565): ONE dry-subtraction for all dissolve taps,
#     never one per tap -- the per-tap form is bit-identical but adds a
#     dozen full-frame operators on the single streaming thread and stalled
#     SUB/WAVE's clock on ~1 dissolve in 5.
#
# SEAM CONTRACT (ours, not SUB/WAVE's):
#   * The cross() this feeds wraps ONLY the music chain (show + filler +
#     requests). Stingers, the hour ID, the beds ducker and the emergency
#     bed all sit ABOVE the cross in radio.liq, so imaging and announcements
#     can never be blended -- SUB/WAVE needed a subwave_jingle flag to
#     protect their jingles (#1565); we get the property by construction.
#   * source_tag dispatch (the P2 #5 contract, stamped by
#     director/playlist.js): a seam where either side is "speech" or
#     "jingle" is a HARD CUT (sequence) -- the 2026-07-28 lesson, where the
#     rejected crossfade() audibly clipped the DJ. Only music<->music (and
#     untagged, i.e. listener requests, which are music) seams blend.
#   * Effect arming is metadata-driven and deterministic, never random:
#       liq_washout="1"  on the ENDING track (a)   -- rides the outgoing
#                          audio; optional liq_washout_delay (seconds,
#                          default 0.30) tempo-syncs the slapback tap.
#       liq_dissolve="1" on the INCOMING track (b) -- washes the outgoing
#                          audio into ambience under the new pick.
#       liq_sweep="1"    on the INCOMING track (b) -- filter choke on the
#                          outgoing + surfacing/bass-swap on the incoming.
#     Precedence when several flags meet at one seam: washout beats
#     dissolve beats sweep (a washing seam is already dissolving the old
#     track; arming more would stack full-wet stages and crater the
#     mid-band). Flags ride normal annotate: lines, e.g.
#     annotate:source_tag="music",liq_fade_in="2",liq_sweep="1":/path
#     (src/liquidsoap/stampTransitionFlags.js edits m3u files in place).
#
# DEVIATIONS from SUB/WAVE (all deliberate, all about our contract):
#   * Three effects, not six: chop / exit-loop / blend / stem-blends need
#     BPM/beat-phase and stem analysis we deliberately don't run (no-AI,
#     no-torch architecture). The three kept effects are self-contained
#     signal shapes needing no analysis sidecar.
#   * No cross-stamp machinery: their controller stamps liq_cross_duration
#     per track and cross replays it via persist_override; our buffer is
#     one literal (dj_transition_buffer below) and d is sized from what
#     cross actually buffered (source.remaining), falling back to the
#     literal. persist_override=true is still set in radio.liq: with no
#     stamps it is a no-op, and if an operator ever hand-stamps a track,
#     it behaves the SUB/WAVE way.
#   * Plain-seam fades span the FULL buffer on both sides (their
#     equal-amplitude invariant, sum ~1.0 across the blend). Our tracks
#     additionally carry their own liq_fade_in=2 shaping inside the
#     playlist source; that extra envelope only ever makes the incoming
#     QUIETER than the complement (both envelopes <= 1), so the blend can
#     dip slightly but never bump above unity -- the +6 dB hazard SUB/WAVE
#     documents comes from fades that HOLD full level early, which this
#     shape cannot do.
#
# Reversibility: delete the %include line and the cross() wiring block in
# radio.liq -- the station returns to hard cuts with per-track liq_fade_in
# shaping, byte-identical to P3 #10 state.

%ifversion >= 2.4.6

# Cross buffer in seconds: how much of the outgoing tail and incoming head
# cross() hands the transition. 3.5 is the value the 2026-07-28 crossfade()
# attempt tuned by offline RMS-envelope testing against real DJ-audio +
# track assets; the attempt was rejected for clipping the DJ (a problem the
# source_tag hard-cut seam now solves at the root), the number stays.
# Edit here to retune -- a literal on purpose, like every timing parameter
# in radio.liq (json.parse type stays untouched, older configs still boot).
dj_transition_buffer = 3.5

def dj_transition(a, b) =
  # BUFFER SIZING. cross buffers whole frames, so what it actually buffered
  # (min of the two sides' remaining) is the one length the fades can trust;
  # the literal is only the fallback for a side that cannot report a length.
  # Bounded at 600 like SUB/WAVE: a remaining() gone huge means the estimate
  # is meaningless (live/infinite source) -- fade over the literal instead.
  buffered = min(source.remaining(a.source), source.remaining(b.source))
  d = if buffered > 0. and buffered < 600. then buffered else dj_transition_buffer end
  # SEAM DISPATCH. source_tag is the P2 #5 contract (director/playlist.js
  # stamps every produced entry; imaging playlists above the cross carry
  # their own tags but never reach this function). Untagged = bare paths =
  # listener requests = music. Speech and jingle seams stay HARD CUTS: the
  # DJ is never faded, never overlapped (2026-07-28), and a jingle plays
  # dry start to finish (SUB/WAVE #1565's "a jingle is never blended").
  speech_out = a.metadata["source_tag"] == "speech"
  speech_in = b.metadata["source_tag"] == "speech"
  jingle_out = a.metadata["source_tag"] == "jingle"
  jingle_in = b.metadata["source_tag"] == "jingle"
  if speech_out or speech_in or jingle_out or jingle_in then
    (sequence([a.source, b.source]) : source)
  else
    # EFFECT ARMING. Flags on a (ending) or b (incoming) decide which
    # gesture reshapes the outgoing audio; precedence washout > dissolve >
    # sweep is enforced here too (the stamping tool also strips losers, but
    # hand-edited m3u lines must not stack full-wet stages).
    washing = a.metadata["liq_washout"] == "1"
    dissolving = b.metadata["liq_dissolve"] == "1" and not washing
    sweeping = b.metadata["liq_sweep"] == "1" and not washing and not dissolving
    # FADE SHAPE per effect. exp drops the dry EARLY so the washout's tail
    # reads as a dissolve (it dips below unity mid-cross, which is the
    # effect). log holds the outgoing hot so the EFFECT rather than the
    # fader does the removal -- a sweep over an already-quiet track is
    # inaudible. Dissolve rides the LINEAR fade (its copies are seeded
    # while the track is still near full level). Plain seams: lin on both
    # sides, the equal-amplitude complement (see DEVIATIONS).
    a_source =
      if washing then
        fade.out(duration=d, type="exp", initial_metadata=a.metadata, a.source)
      elsif sweeping then
        fade.out(duration=d, type="log", initial_metadata=a.metadata, a.source)
      else
        fade.out(duration=d, initial_metadata=a.metadata, a.source)
      end
    # SWEEP ENVELOPE -- riding the filter out of the outgoing track.
    # Cutoffs move in LOG-frequency space (pow) throughout; linear Hz ramps
    # read as nothing-then-everything. Close FAST and DEEP -- 9 kHz to
    # 1.1 kHz over the first 45% of the blend -- so the choke arrives while
    # the outgoing is still loud; then hold, and PARTIALLY re-open as the
    # incoming takes over (a sustained floor reads as "the track went
    # quiet", a re-open reads as a gesture).
    a_source =
      if sweeping then
        log("DJ sweep: closing the filter over the outgoing track (d=#{d}s)")
        sweep_src = a_source
        def sweep_cut() =
          e = source.elapsed(sweep_src)
          e = if e < 0. then 0. else e end
          t_close = 0.45 * d
          t_hold  = 0.55 * d
          t_back  = 0.85 * d
          depth =
            if e < t_close then
              x = e / t_close
              3.0 * x * x - 2.0 * x * x * x
            elsif e < t_hold then
              1.0
            elsif e < t_back then
              x = (e - t_hold) / (t_back - t_hold)
              1.0 - 0.6 * (3.0 * x * x - 2.0 * x * x * x)
            else
              0.4
            end
          9000.0 * pow(1100.0 / 9000.0, depth)
        end
        # Makeup on the choked branch: the filter guts the outgoing's
        # energy while the incoming is only half-faded, so lift the
        # residual +2.6 dB as the cutoff bottoms out. Without it the
        # mid-blend goes near-quiet.
        def sweep_gain() =
          e = source.elapsed(sweep_src)
          e = if e < 0. then 0. else e end
          g_max = 1.35
          t_from = 0.30 * d
          t_to   = 0.50 * d
          if e <= t_from then 1.0
          elsif e >= t_to then g_max
          else
            x = (e - t_from) / (t_to - t_from)
            1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
          end
        end
        # PARALLEL DRY BLEED -- why the stages run full-wet. Wetness on
        # cascaded stages MULTIPLIES the dry path (0.35 x 0.35 ~= 12%),
        # so a wetness cap craters the mid-band. An explicit dry branch
        # around a full-wet chain gives a hard floor: 30% of the untouched
        # track reaches the mix however deep the cutoff dives.
        swept = filter.rc(frequency=sweep_cut, mode="low", wetness=1.,
                  filter.rc(frequency=sweep_cut, mode="low", wetness=1., a_source))
        amplify(sweep_gain, add(normalize=false,
          [amplify(0.30, a_source), amplify(0.75, swept)]))
      else
        a_source
      end
    # WASHOUT ENVELOPE -- a tempo-synced slapback under the exp fade. This
    # build's `comb` is a ONE-SHOT feed-forward echo: `feedback` is the
    # level of a SINGLE delayed copy (in dB), so this is one echo of the
    # fading track one tap behind it, not a recirculating dub tail. The
    # echo is swelled in while the exp fade pulls the dry away, and must be
    # dead before the transition source truncates at d, or it clicks off.
    # Tap length (liq_washout_delay) is stamped on the ending track,
    # tempo-synced to a dotted eighth of its BPM by whoever produces it.
    a_source =
      if washing then
        wd = float_of_string(default=0.30, a.metadata["liq_washout_delay"])
        log("DJ washout: dissolving the outgoing track, tap=#{wd}s (d=#{d}s)")
        wash_src = a_source
        # The swell must beat the exp fade: swelling at 25% echoes an
        # already-faded signal and the echo is inaudible. Level is bounded
        # by the exp fade starving the input, plus the bus limiter.
        def wash_fb() =
          e = source.elapsed(wash_src)
          e = if e < 0. then 0. else e end
          fb_max = -1.0            # peak echo level, dB (one-shot comb)
          fb_off = -90.0           # idle/silent
          t_swell = 0.10 * d
          t_hold  = 0.85 * d
          t_rel   = 0.97 * d
          if e < t_swell then
            x = e / t_swell
            s = 3.0 * x * x - 2.0 * x * x * x       # smoothstep swell
            fb_off + s * (fb_max - fb_off)
          elsif e < t_hold then
            fb_max
          elsif e < t_rel then
            fb_max + ((e - t_hold) / (t_rel - t_hold)) * (fb_off - fb_max)
          else
            fb_off
          end
        end
        # Late makeup so the echo sits PRESENT over the incoming fade-in.
        # It comes up only after the exp fade has dropped the dry, so it
        # lifts the echo and never bumps the still-audible song.
        def wash_gain() =
          e = source.elapsed(wash_src)
          e = if e < 0. then 0. else e end
          g_max = 1.95             # ~ +5.8 dB -- over a dense incoming mix
          t_from = 0.30 * d
          t_to   = 0.55 * d
          if e <= t_from then 1.0
          elsif e >= t_to then g_max
          else
            x = (e - t_from) / (t_to - t_from)
            1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
          end
        end
        # Darkening. A lowpass AFTER the comb closes across the window
        # (9 kHz -> 3 kHz), so the track and its echo recede together. Wet
        # must ramp in: an RC at 9 kHz is not transparent, and engaging it
        # full-wet would dull the still-audible dry.
        def tail_cut() =
          e = source.elapsed(wash_src)
          e = if e < 0. then 0. else e end
          t_from = 0.35 * d
          t_to   = 0.90 * d
          x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
          s = 3.0 * x * x - 2.0 * x * x * x
          9000.0 * pow(3000.0 / 9000.0, s)
        end
        def tail_wet() =
          e = source.elapsed(wash_src)
          e = if e < 0. then 0. else e end
          t_on = 0.20 * d
          x = if e >= t_on then 1.0 else e / t_on end
          3.0 * x * x - 2.0 * x * x * x
        end
        washed = comb(delay=wd, feedback=wash_fb, a_source)
        washed = filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet,
                   filter.rc(frequency=tail_cut, mode="low", wetness=tail_wet, washed))
        amplify(wash_gain, washed)
      else
        a_source
      end
    # DISSOLVE ENVELOPE -- a smear of early reflections. Same topology as
    # the washout (comb -> cascaded damped lowpass -> late makeup) with two
    # differences: FOUR parallel combs at mutually prime, tempo-UNRELATED
    # delays (89/113/151/181 ms), so the copies smear into ambience instead
    # of a rhythmic pulse (diffusion from the prime spread plus damping --
    # no allpass exists in the proven kit); and the damping lowpass closes
    # deeper (7 kHz -> 1.2 kHz). Each comb is ONE-SHOT, so this is four
    # delayed copies of the fading track, not a multi-second reverb tail.
    a_source =
      if dissolving then
        log("DJ dissolve: reverb wash under the next track (d=#{d}s)")
        diss_src = a_source
        def diss_fb() =
          e = source.elapsed(diss_src)
          e = if e < 0. then 0. else e end
          fb_max = -0.5
          fb_off = -90.0
          t_swell = 0.10 * d
          t_hold  = 0.80 * d
          t_rel   = 0.93 * d
          if e < t_swell then
            x = e / t_swell
            s = 3.0 * x * x - 2.0 * x * x * x
            fb_off + s * (fb_max - fb_off)
          elsif e < t_hold then
            fb_max
          elsif e < t_rel then
            fb_max + ((e - t_hold) / (t_rel - t_hold)) * (fb_off - fb_max)
          else
            fb_off
          end
        end
        # Late makeup, lower than the washout's figure because these four
        # taps start well below its single unity tap.
        def diss_gain() =
          e = source.elapsed(diss_src)
          e = if e < 0. then 0. else e end
          g_max = 1.3
          t_from = 0.25 * d
          t_to   = 0.50 * d
          if e <= t_from then 1.0
          elsif e >= t_to then g_max
          else
            x = (e - t_from) / (t_to - t_from)
            1.0 + (3.0 * x * x - 2.0 * x * x * x) * (g_max - 1.0)
          end
        end
        def diss_cut() =
          e = source.elapsed(diss_src)
          e = if e < 0. then 0. else e end
          t_from = 0.30 * d
          t_to   = 0.90 * d
          x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
          s = 3.0 * x * x - 2.0 * x * x * x
          7000.0 * pow(1200.0 / 7000.0, s)
        end
        def diss_wet() =
          e = source.elapsed(diss_src)
          e = if e < 0. then 0. else e end
          t_on = 0.10 * d
          x = if e >= t_on then 1.0 else e / t_on end
          3.0 * x * x - 2.0 * x * x * x
        end
        # PURE-COPY isolation: comb passes its input through, so summing
        # four combs directly would force a 0.25 weight to keep the dry at
        # unity and bury the copies 12 dB down (SUB/WAVE measured a -44 dB
        # mid-cross crater that way). Subtracting the dry ONCE -- never per
        # tap, see the performance constraint above -- leaves ONLY the four
        # delayed copies.
        washed = add(normalize=false,
          [comb(delay=0.089, feedback=diss_fb, a_source),
           comb(delay=0.113, feedback=diss_fb, a_source),
           comb(delay=0.151, feedback=diss_fb, a_source),
           comb(delay=0.181, feedback=diss_fb, a_source),
           amplify(-4., a_source)])
        washed = amplify(0.7, washed)
        washed = filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet,
                   filter.rc(frequency=diss_cut, mode="low", wetness=diss_wet, washed))
        # Dry (faded) + wash: the track walks out through its own ambience.
        add(normalize=false, [a_source, amplify(diss_gain, washed)])
      else
        a_source
      end
    # Incoming side: fade.in over the FULL buffer (the complement of the
    # outgoing's fade.out -- equal-amplitude invariant), plus the sweep's
    # incoming moves when armed. The track's own liq_fade_in shaping is
    # already baked in inside the playlist source and only ever dips the
    # blend further below unity (DEVIATIONS above).
    b_source = fade.in(duration=d, initial_metadata=b.metadata, b.source)
    b_source =
      if sweeping then
        in_src = b_source
        # SURFACING: a lowpass opens 500 Hz -> 9 kHz while the old track
        # still dominates; it must open fast and early (fully open by 30%),
        # or the muffle outlives the transition. Wetness releases 1 -> 0 by
        # 32%: the branch operators vanish at the d boundary, so the track
        # must be bit-clean well before then -- every incoming gesture
        # releases by driving WETNESS to 0, never by parking the cutoff
        # open (an RC at its open cutoff is still not transparent).
        def surf_cut() =
          e = source.elapsed(in_src)
          e = if e < 0. then 0. else e end
          t_open = 0.30 * d
          x = if e >= t_open then 1.0 else e / t_open end
          s = 3.0 * x * x - 2.0 * x * x * x
          500.0 * pow(9000.0 / 500.0, s)
        end
        def surf_wet() =
          e = source.elapsed(in_src)
          e = if e < 0. then 0. else e end
          t_from = 0.20 * d
          t_to   = 0.32 * d
          x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
          1.0 - (3.0 * x * x - 2.0 * x * x * x)
        end
        # BASS SWAP -- hold the pick's low end back so two basslines never
        # fight across the blend, then release (38-55%). Built as a
        # SUBTRACT-HPF: filter.rc mode="high" is broken (see header), so
        # subtract the track's own <160 Hz content and ease that
        # subtraction to zero.
        def bass_amt() =
          e = source.elapsed(in_src)
          e = if e < 0. then 0. else e end
          t_from = 0.38 * d
          t_to   = 0.55 * d
          x = if e <= t_from then 0.0 elsif e >= t_to then 1.0 else (e - t_from) / (t_to - t_from) end
          0.0 - (1.0 - (3.0 * x * x - 2.0 * x * x * x))
        end
        bs = filter.rc(frequency=surf_cut, mode="low", wetness=surf_wet,
               filter.rc(frequency=surf_cut, mode="low", wetness=surf_wet, in_src))
        bs_low = filter.rc(frequency=160., mode="low", wetness=1., bs)
        add(normalize=false, [bs, amplify(bass_amt, bs_low)])
      else
        b_source
      end
    add(normalize=false, [a_source, b_source])
  end
end

%endif
