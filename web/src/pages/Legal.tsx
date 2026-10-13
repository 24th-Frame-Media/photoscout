import { Link } from 'react-router-dom';

/** Where people write about their data or these terms. */
const CONTACT = 'privacy@24thframe.media';
const UPDATED = '14 October 2026';

/**
 * The privacy policy and terms, one page each. Plain words about what this
 * app actually does with what it holds; keep it in step with the code.
 */
export default function Legal({ page }: { page: 'privacy' | 'terms' }) {
  return (
    <div className="page legal">
      <p className="hint">
        <Link to="/privacy">Privacy</Link> · <Link to="/terms">Terms</Link> · Updated {UPDATED}
      </p>
      {page === 'privacy' ? <Privacy /> : <Terms />}
    </div>
  );
}

function Privacy() {
  return (
    <>
      <h1>Privacy</h1>
      <p>
        PhotoScout is run by 24th Frame Media from servers in Australia. This page says what it keeps about you,
        why, who else sees it, and how to get it removed. Write to <code>{CONTACT}</code> about any of it.
      </p>

      <h2>What we keep</h2>
      <ul>
        <li><b>Your account.</b> When you sign in with Discord we keep your Discord account id, the display name we turn into your handle, and your avatar. We never ask for your email address and there is no password.</li>
        <li><b>A sign-in cookie.</b> One cookie keeps you signed in. We store only a hash of it. There are no advertising or tracking cookies and no analytics.</li>
        <li><b>What you add.</b> Places, spots, routes, photos, kit, posts, chat messages, community events and RSVPs, and your settings. Each item is private, unlisted or public as you choose; public items can be seen by anyone, signed in or not.</li>
        <li><b>Photo details.</b> We keep a photo's size and the time it says it was taken. Location data in photos you upload stays in the file, so remove it first if you don't want it shared with a public photo.</li>
        <li><b>Server logs.</b> Our web firewall logs each request's IP address, country, time and address for security and to stop abuse.</li>
      </ul>

      <h2>Your location</h2>
      <p>
        The map, Drive and Convoy use your device's location only after your browser asks you and you agree. On the map
        and in Drive it stays on your device, apart from the start and end of a route you ask directions for. In a
        convoy, your live position is sent to the server and shown to the other people in that convoy while you're in
        it. It's held in memory only, never written to disk, and gone when the convoy ends or the server restarts.
      </p>

      <h2>Who else sees it</h2>
      <ul>
        <li><b>Discord</b>, when you sign in.</li>
        <li><b>Map and data services</b> receive the places you look at, not who you are: OpenStreetMap and OpenFreeMap (map tiles and place search), Esri (satellite imagery), RainViewer (rain radar), the OSRM routing service (the start and end of directions you ask for), Open-Meteo (weather), and public feeds such as NSW RFS, Transport for NSW and aircraft trackers.</li>
        <li><b>Other users</b>, for anything you make public or unlisted, and your handle and avatar wherever you post.</li>
      </ul>
      <p>We don't sell your data or share it with advertisers.</p>
      <p>
        The events list is gathered from public pages and posts on the web, including Facebook and Instagram. We keep
        the event details and a link to where they came from, not the people who posted them.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Your account and content stay until you delete them or ask us to. Deleted items are removed from the live
        database straight away and from our backups within 14 days. Server logs are kept only as long as we need them to keep the service secure.
      </p>

      <h2>Your choices</h2>
      <p>
        You can change or delete what you've added at any time. To get a copy of your data, use Import / export. To
        delete your account and everything in it, write to <code>{CONTACT}</code> from the Discord account it belongs
        to, or tell an admin in the app. You can also ask us to correct anything we hold. If you're unhappy with how we
        handle your information, you can complain to the Office of the Australian Information Commissioner.
      </p>

      <h2>Children</h2>
      <p>PhotoScout is not for anyone under 16.</p>

      <h2>Changes</h2>
      <p>If this policy changes in a way that matters, we'll say so in the app before it takes effect.</p>
    </>
  );
}

function Terms() {
  return (
    <>
      <h1>Terms</h1>
      <p>
        By using PhotoScout you agree to these terms. PhotoScout is run by 24th Frame Media. If you don't agree, please
        don't use it. Questions to <code>{CONTACT}</code>.
      </p>

      <h2>Your account</h2>
      <p>
        You need to be 16 or over. Keep your Discord account secure; you're responsible for what's done with your
        PhotoScout account. One account per person.
      </p>

      <h2>What you post</h2>
      <p>
        You keep ownership of everything you add. By making something public or unlisted, you let us store and show it
        in PhotoScout so others can see it. Only post photos and information you have the right to share.
      </p>
      <p>Don't post or do anything that:</p>
      <ul>
        <li>is illegal, harassing, hateful, sexually explicit, or threatens anyone;</li>
        <li>shares someone else's private information or location without their consent;</li>
        <li>encourages trespass, dangerous driving, or breaking road rules;</li>
        <li>is spam, or tries to break, overload, scrape or get around the limits of the service.</li>
      </ul>
      <p>
        Moderators and admins can hide or remove content and suspend accounts that break these terms, without notice
        where it's needed.
      </p>

      <h2>Spots, routes and driving</h2>
      <p>
        Spots, access notes, routes, directions and event details come from other users and public sources and may be
        wrong or out of date. Check access and permissions yourself and obey the law, signs and landowners. Directions
        and Drive are a guide only: watch the road, follow road rules, and don't handle your phone while driving. In a
        convoy, each driver is responsible for their own driving.
      </p>

      <h2>The service</h2>
      <p>
        PhotoScout is free and provided as it is. We try to keep it running and your data safe, but we can't promise it
        will always be available or error-free, and we may change or end features. Keep your own copies of anything
        important.
      </p>
      <p>
        To the extent the law allows, we aren't liable for any loss arising from your use of PhotoScout, including
        from relying on content in it. Nothing in these terms excludes rights you have under the Australian Consumer Law
        that can't be excluded.
      </p>

      <h2>Ending</h2>
      <p>You can stop using PhotoScout and ask us to delete your account at any time. We can suspend or close accounts that break these terms.</p>

      <h2>Law</h2>
      <p>These terms are governed by the laws of New South Wales, Australia.</p>

      <h2>Changes</h2>
      <p>We may update these terms. If a change matters, we'll say so in the app before it takes effect.</p>
    </>
  );
}
