import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Profile as ProfileData, type User } from '../api.js';
import { gearTitle, instagramUrl, rideTitle } from '../kit.js';

/**
 * Somebody's public page: who they are, what they drive and what they shoot with.
 * Anyone can read it; a signed-in visitor can follow them. Everything is plain
 * text rendered by React, and the Instagram handle becomes a link only after it
 * passes the same check the server applies.
 */
export default function Profile({ user }: { user: User | null }) {
  const { username = '' } = useParams();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setProfile(null);
    setError('');
    api.profile(username).then(setProfile).catch((err) => setError((err as Error).message));
  }, [username]);

  async function toggleFollow() {
    if (!profile) return;
    setBusy(true);
    setError('');
    try {
      if (profile.isFollowing) await api.unfollow(profile.username);
      else await api.follow(profile.username);
      setProfile(await api.profile(username));
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (error && !profile) return <div className="page"><p className="status-line error">{error}</p></div>;
  if (!profile) return <div className="page"><p className="hint">Loading…</p></div>;

  const mine = user?.id === profile.id;
  const instagram = profile.instagram ? instagramUrl(profile.instagram) : null;
  return (
    <div className="page profile">
      <div className="profile__head">
        {profile.avatar && <img className="profile__avatar" src={profile.avatar} alt="" referrerPolicy="no-referrer" />}
        <div>
          <h1>{profile.username}</h1>
          <p className="hint">{profile.followers} follower{profile.followers === 1 ? '' : 's'} · {profile.following} following · joined {new Date(profile.createdAt).toLocaleDateString()}</p>
          {instagram && <p><a href={instagram} target="_blank" rel="noopener noreferrer">@{profile.instagram} on Instagram</a></p>}
        </div>
        <div className="profile__actions">
          {mine && <Link className="button" to="/kit">Edit profile and Kit</Link>}
          {!mine && user && <button className={profile.isFollowing ? '' : 'primary'} disabled={busy} onClick={() => void toggleFollow()}>{profile.isFollowing ? 'Following' : 'Follow'}</button>}
          {!user && <span className="hint">Sign in to follow.</span>}
        </div>
      </div>
      {error && <p className="status-line error">{error}</p>}
      {profile.bio && <p className="profile__bio">{profile.bio}</p>}

      <h2>Rides</h2>
      {profile.rides.length === 0 ? <p className="hint">No rides listed.</p> : (
        <div className="spotgrid">
          {profile.rides.map((r) => (
            <article key={r.id} className="spotcard">
              <h3>{r.kind === 'motorbike' ? '🏍️' : '🚗'} {rideTitle(r)}</h3>
              {r.notes && <p className="hint">{r.notes}</p>}
              {r.photos.length > 0 && (
                <div className="kitphotos">
                  {r.photos.map((p) => (
                    <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer"><img src={p.thumbUrl} alt={rideTitle(r)} loading="lazy" /></a>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <h2>Gear</h2>
      {profile.gear.length === 0 ? <p className="hint">No gear listed.</p> : (
        <ul className="profile__gear">
          {profile.gear.map((g) => (
            <li key={g.id}>
              <span className="eventbadge">{g.kind}</span> <strong>{gearTitle(g)}</strong>
              {g.notes && <span className="hint"> — {g.notes}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
