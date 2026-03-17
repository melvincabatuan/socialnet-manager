// js/app.js
// ================================================================
// Section 1: Supabase Client Initialization
// ================================================================

// The supabase global object is made available by the CDN script
// tag in index.html. We destructure createClient from it so we
// can call createClient() directly without typing supabase.createClient().
const { createClient } = supabase;

const SUPABASE_URL = "https://mnwowwgzjsounxhcoonu.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_IxXIJWmbOEIS7SeFCZaY7g_zu2T2OFR";

// db is our connection handle. Every Supabase call starts with db.from(...)
const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
 
// ================================================================
// Section 2: Application Constants and State
// ================================================================
 
// DEFAULT_AVATAR is shown whenever a profile has no picture stored
// in Supabase, or when an image fails to load. After migrating to
// Vercel Blob you should replace this string with the full Blob URL
// of your uploaded default silhouette image, e.g.:
//   "https://abc123.public.blob.vercel-storage.com/avatars/default.webp"
// Until then, the local fallback is used so the app still works in
// development without a Blob token.
const DEFAULT_AVATAR = "resources/images/default.png";
 
// currentProfileId holds the UUID of the profile currently shown in
// the centre panel. It starts as null (nothing selected). Most action
// buttons check this first and show an error message if it is null.
let currentProfileId = null;
 
 
// ================================================================
// Section 3: Helper Functions
// ================================================================
 
// setStatus — writes a message to the status bar at the bottom.
// isError = true turns the bar red to signal a problem.
function setStatus(message, isError = false) {
  const bar    = document.getElementById("status-message");
  const footer = document.getElementById("status-bar");
  bar.textContent         = message;
  footer.style.background = isError ? "#6b1a1a" : "var(--clr-status-bg)";
  footer.style.color      = isError ? "#ffcccc"  : "var(--clr-status-text)";
}
 
// clearCentrePanel — resets the centre panel to "nothing selected".
function clearCentrePanel() {
  document.getElementById("profile-pic").src         = DEFAULT_AVATAR;
  document.getElementById("profile-name").textContent  = "No Profile Selected";
  document.getElementById("profile-status").textContent = "\u2014";
  document.getElementById("profile-quote").textContent  = "\u2014";
  document.getElementById("friends-list").innerHTML     = "";
  currentProfileId = null;
}
 
// displayProfile — fills the centre panel with one profile's data.
//   profile : full row object from Supabase (id, name, status, quote, picture)
//   friends : array of { id, name } objects resolved in selectProfile
function displayProfile(profile, friends = []) {
  document.getElementById("profile-pic").src =
    profile.picture || DEFAULT_AVATAR;
  document.getElementById("profile-name").textContent   = profile.name;
  document.getElementById("profile-status").textContent =
    profile.status || "(no status set)";
  document.getElementById("profile-quote").textContent  =
    profile.quote  || "(no quote set)";
  currentProfileId = profile.id;
  renderFriendsList(friends);
  setStatus(`Displaying ${profile.name}.`);
}
 
// renderFriendsList — builds the friends list HTML in the centre panel.
// Expects an array of { id, name } objects.
function renderFriendsList(friends) {
  const box = document.getElementById("friends-list");
  box.innerHTML = "";
 
  if (friends.length === 0) {
    box.innerHTML = '<p class="empty-state">No friends yet.</p>';
    return;
  }
 
  friends.forEach((f) => {
    const div = document.createElement("div");
    div.className   = "friend-entry";
    div.textContent = f.name;
    box.appendChild(div);
  });
}
 
// showUploadProgress / hideUploadProgress — animates the progress bar
// in the right panel while the image is being compressed and uploaded.
// The bar uses a CSS infinite-loop animation defined in style.css so it
// does not need a real percentage value (we do not receive upload progress
// events from the Fetch API in this setup).
function showUploadProgress(label = "Uploading...") {
  const wrapper = document.getElementById("upload-progress");
  const text    = document.getElementById("upload-progress-label");
  text.textContent = label;
  wrapper.hidden   = false;
}
 
function hideUploadProgress() {
  document.getElementById("upload-progress").hidden = true;
}
 
 
// ================================================================
// Section 4: CRUD Functions
// ================================================================
 
// loadProfileList — fetches all profiles from Supabase ordered by
// name and renders them as clickable rows in the left panel list.
async function loadProfileList() {
  try {
    const { data, error } = await db
      .from("profiles")
      .select("id, name, picture")
      .order("name", { ascending: true });
 
    if (error) throw error;
 
    const container = document.getElementById("profile-list");
    container.innerHTML = "";
 
    if (data.length === 0) {
      container.innerHTML = '<p class="empty-state">No profiles found.</p>';
      return;
    }
 
    data.forEach((profile) => {
      const row = document.createElement("div");
      row.className  = "profile-item";
      row.dataset.id = profile.id;
 
      const img = document.createElement("img");
      img.className = "list-thumb";
      // profile.picture is now a Vercel Blob HTTPS URL (or the DEFAULT_AVATAR
      // fallback for profiles that have not had a picture set yet).
      img.src = profile.picture || DEFAULT_AVATAR;
      img.alt = profile.name;
      // If the Blob URL is unreachable (e.g. the file was deleted from Blob
      // storage), fall back to the default silhouette so the list still renders.
      img.onerror = () => { img.src = DEFAULT_AVATAR; };
 
      const span = document.createElement("span");
      span.textContent = profile.name;
 
      row.appendChild(img);
      row.appendChild(span);
      row.addEventListener("click", () => selectProfile(profile.id));
      container.appendChild(row);
    });
 
  } catch (err) {
    setStatus(`Error loading profiles: ${err.message}`, true);
  }
}
 
 
// selectProfile — loads and displays one profile in the centre panel.
//
// BIDIRECTIONAL FRIENDSHIP QUERY EXPLANATION
// ──────────────────────────────────────────
// The friends table stores ONE canonical row per pair.
// The UUID that is lexicographically smaller always goes in profile_id.
// So for profiles A and B:
//   if A < B  →  row is (profile_id=A, friend_id=B)
//   if B < A  →  row is (profile_id=B, friend_id=A)
//
// To find ALL friends of profile X we need rows where X appears in
// EITHER column, hence the .or() filter.
// We then resolve the OTHER UUID (the friend's ID) from each row
// and look up all their names in one .in() query.
async function selectProfile(profileId) {
  try {
    // 1. Highlight the active row in the left panel list
    document.querySelectorAll("#profile-list .profile-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.id === profileId);
    });
 
    // 2. Fetch the full profile row
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("*")
      .eq("id", profileId)
      .single(); // returns a plain object rather than a one-item array
 
    if (profileError) throw profileError;
 
    // 3. Fetch all friendship rows where this profile appears on either side
    const { data: rows, error: friendsError } = await db
      .from("friends")
      .select("profile_id, friend_id")
      .or(`profile_id.eq.${profileId},friend_id.eq.${profileId}`);
 
    if (friendsError) throw friendsError;
 
    // 4. Extract the OTHER person's UUID from each row
    const friendIds = rows.map((row) =>
      row.profile_id === profileId ? row.friend_id : row.profile_id
    );
 
    // 5. Resolve friend names in one query
    let friendNames = [];
    if (friendIds.length > 0) {
      const { data: nameRows, error: nameError } = await db
        .from("profiles")
        .select("id, name")
        .in("id", friendIds)
        .order("name", { ascending: true });
 
      if (nameError) throw nameError;
      friendNames = nameRows;
    }
 
    // 6. Render
    displayProfile(profile, friendNames);
 
  } catch (err) {
    setStatus(`Error selecting profile: ${err.message}`, true);
  }
}
 
 
// addProfile — creates a new profile row in Supabase with just a name.
// All other columns (status, quote, picture) use their database defaults.
async function addProfile() {
  const nameInput = document.getElementById("input-name");
  const name      = nameInput.value.trim();
 
  if (!name) {
    setStatus("Error: Name field is empty. Please enter a name.", true);
    return;
  }
 
  try {
    const { data, error } = await db
      .from("profiles")
      .insert({ name })
      .select()
      .single();
 
    if (error) {
      // Postgres error 23505 = UNIQUE constraint violation (duplicate name)
      if (error.code === "23505") {
        setStatus(`Error: A profile named "${name}" already exists.`, true);
      } else {
        throw error;
      }
      return;
    }
 
    nameInput.value = "";
    await loadProfileList();
    await selectProfile(data.id);
    setStatus(`Profile "${name}" created successfully.`);
 
  } catch (err) {
    setStatus(`Error adding profile: ${err.message}`, true);
  }
}
 
 
// lookUpProfile — searches for a profile by partial, case-insensitive
// name match and selects the first result.
async function lookUpProfile() {
  const query = document.getElementById("input-name").value.trim();
 
  if (!query) {
    setStatus("Error: Name field is empty. Please enter a name to search.", true);
    return;
  }
 
  try {
    // .ilike() = case-insensitive LIKE. "%" matches anything before/after the query.
    const { data, error } = await db
      .from("profiles")
      .select("id, name")
      .ilike("name", `%${query}%`)
      .order("name", { ascending: true })
      .limit(1);
 
    if (error) throw error;
 
    if (data.length === 0) {
      setStatus(`No profile found matching "${query}".`, true);
      clearCentrePanel();
      return;
    }
 
    await selectProfile(data[0].id);
 
  } catch (err) {
    setStatus(`Error looking up profile: ${err.message}`, true);
  }
}
 
 
// deleteProfile — deletes the current profile after user confirmation.
// ON DELETE CASCADE in the database removes all related friend rows automatically.
async function deleteProfile() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected. Click a profile in the list first.", true);
    return;
  }
 
  const name = document.getElementById("profile-name").textContent;
 
  if (!window.confirm(`Delete the profile for "${name}"? This cannot be undone.`)) {
    setStatus("Deletion cancelled.");
    return;
  }
 
  try {
    const { error } = await db
      .from("profiles")
      .delete()
      .eq("id", currentProfileId);
 
    if (error) throw error;
 
    clearCentrePanel();
    await loadProfileList();
    setStatus(`Profile "${name}" deleted. All friendship records removed automatically.`);
 
  } catch (err) {
    setStatus(`Error deleting profile: ${err.message}`, true);
  }
}
 
 
// changeStatus — updates the status column and reflects it immediately.
async function changeStatus() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }
  const newStatus = document.getElementById("input-status").value.trim();
  if (!newStatus) {
    setStatus("Error: Status field is empty.", true);
    return;
  }
  try {
    const { error } = await db
      .from("profiles")
      .update({ status: newStatus })
      .eq("id", currentProfileId);
 
    if (error) throw error;
 
    document.getElementById("profile-status").textContent = newStatus;
    document.getElementById("input-status").value = "";
    setStatus("Status updated.");
 
  } catch (err) {
    setStatus(`Error updating status: ${err.message}`, true);
  }
}
 
 
// changeQuote — updates the favourite quote column.
async function changeQuote() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }
  const newQuote = document.getElementById("input-quote").value.trim();
  if (!newQuote) {
    setStatus("Error: Quote field is empty.", true);
    return;
  }
  try {
    const { error } = await db
      .from("profiles")
      .update({ quote: newQuote })
      .eq("id", currentProfileId);
 
    if (error) throw error;
 
    document.getElementById("profile-quote").textContent = newQuote;
    document.getElementById("input-quote").value = "";
    setStatus("Favorite quote updated.");
 
  } catch (err) {
    setStatus(`Error updating quote: ${err.message}`, true);
  }
}
 
 
// ================================================================
// Section 5: Picture Update — Vercel Blob Upload
// ================================================================
//
// changePicture supports two modes, checked in priority order:
//
// MODE A — File upload (priority)
//   The user selected a file with the <input type="file"> picker.
//   Steps:
//     1. Read the File object from the input element.
//     2. POST it as multipart/form-data to /api/upload-avatar.
//     3. The serverless function (api/upload-avatar.js) compresses
//        the image with sharp (max 256px, WebP quality 80) and
//        uploads it to Vercel Blob, then returns the public URL.
//     4. Save the returned URL to the profiles.picture column in
//        Supabase.
//     5. Update the UI.
//
// MODE B — URL input (fallback)
//   The user pasted a URL into the text input instead of picking
//   a file. We validate it starts with "https://" and save it
//   directly to Supabase without uploading anything to Blob.
//   This is useful for pasting existing Blob URLs or any other
//   publicly accessible image address.
//
// If neither input has a value, we show an error.
// If both have values, Mode A (file upload) takes priority.
// ================================================================
 
async function changePicture() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }
 
  // Read both input elements
  const fileInput = document.getElementById("input-picture-file");
  const urlInput  = document.getElementById("input-picture-url");
  const file      = fileInput.files[0];   // undefined if no file was picked
  const urlValue  = urlInput.value.trim();
 
  // ── Mode A: File upload ───────────────────────────────────────
  if (file) {
    await uploadFileToBlob(file);
    return;
  }
 
  // ── Mode B: Direct URL ────────────────────────────────────────
  if (urlValue) {
    await saveUrlDirectly(urlValue);
    return;
  }
 
  // ── Neither input has a value ─────────────────────────────────
  setStatus("Error: Select a file or enter a URL before clicking Update Picture.", true);
}
 
 
// uploadFileToBlob — sends the selected File to /api/upload-avatar,
// receives the compressed Vercel Blob URL, and saves it to Supabase.
async function uploadFileToBlob(file) {
  // Basic client-side type check before sending to the server.
  // This gives immediate feedback and avoids an unnecessary network round-trip.
  if (!file.type.startsWith("image/")) {
    setStatus("Error: The selected file is not an image.", true);
    return;
  }
 
  // Show the animated progress indicator in the right panel
  showUploadProgress("Compressing and uploading...");
  setStatus("Uploading image to Vercel Blob...");
 
  try {
    // Build a FormData object — this is the multipart/form-data body
    // that /api/upload-avatar expects. The field name must be "file"
    // because that is what the server reads with form.get("file").
    const formData = new FormData();
    formData.append("file", file);
 
    // POST to our Vercel serverless function.
    // The function runs on Vercel's servers and has access to the
    // BLOB_READ_WRITE_TOKEN environment variable — the browser never
    // sees that secret.
    const response = await fetch("/api/upload-avatar", {
      method: "POST",
      body:   formData,
      // Do NOT set Content-Type manually. When body is a FormData
      // object, the browser sets Content-Type automatically and
      // includes the multipart boundary string (--abc123...) that
      // the server needs to parse the fields. Setting it manually
      // would omit the boundary and break parsing on the server.
    });
 
    // Parse the JSON response body regardless of HTTP status
    const result = await response.json();
 
    if (!response.ok) {
      // The server returned 4xx or 5xx with an { error: "..." } body
      throw new Error(result.error || `Server returned ${response.status}`);
    }
 
    // result.url is the public Vercel Blob HTTPS URL of the compressed image
    const blobUrl = result.url;
 
    // Save the new URL to the profiles table in Supabase
    await savePictureUrl(blobUrl);
 
    // Clear the file input so the same file is not accidentally re-uploaded
    document.getElementById("input-picture-file").value = "";
 
  } catch (err) {
    setStatus(`Error uploading image: ${err.message}`, true);
  } finally {
    // Always hide the progress bar when done, whether success or error
    hideUploadProgress();
  }
}
 
 
// saveUrlDirectly — validates and saves a pasted URL to Supabase
// without uploading anything to Vercel Blob.
async function saveUrlDirectly(url) {
  // Require HTTPS for security. HTTP images would be blocked by
  // browsers when the page itself is served over HTTPS (mixed content).
  if (!url.startsWith("https://")) {
    setStatus("Error: URL must start with https://", true);
    return;
  }
 
  setStatus("Saving picture URL...");
 
  try {
    await savePictureUrl(url);
 
  } catch (err) {
    setStatus(`Error saving URL: ${err.message}`, true);
  }
}
 
 
// savePictureUrl — shared helper used by both uploadFileToBlob and
// saveUrlDirectly. Updates the picture column in Supabase and
// refreshes the UI to show the new image.
async function savePictureUrl(newPictureUrl) {
  // Save to Supabase
  const { error } = await db
    .from("profiles")
    .update({ picture: newPictureUrl })
    .eq("id", currentProfileId);
 
  if (error) throw error;
 
  // Update the large profile image in the centre panel immediately
  // so the user sees the change without refreshing the page.
  const profilePic = document.getElementById("profile-pic");
  profilePic.src = newPictureUrl;
 
  // Also update the small circular thumbnail in the active left-panel row
  const activeThumb = document.querySelector(
    "#profile-list .profile-item.active .list-thumb"
  );
  if (activeThumb) activeThumb.src = newPictureUrl;
 
  // Clear the URL input
  document.getElementById("input-picture-url").value = "";
 
  setStatus("Picture updated successfully.");
}
 
 
// ================================================================
// Section 6: Friends Management — Bidirectional
// ================================================================
//
// HOW BIDIRECTIONAL STORAGE WORKS
// ────────────────────────────────
// The friends table stores ONE row per friendship pair (not two).
// The UUID that is lexicographically SMALLER always goes in
// profile_id; the LARGER goes in friend_id.
//
// This "canonical" ordering means (A,B) and (B,A) always produce
// the same row, so the UNIQUE(profile_id, friend_id) constraint
// prevents duplicates regardless of which profile initiated the
// friendship.
//
// addFriend normalizes before INSERT.
// removeFriend normalizes before DELETE.
// selectProfile reads BOTH columns to find all friendships.
// ================================================================
 
async function addFriend() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }
  const friendName = document.getElementById("input-friend").value.trim();
  if (!friendName) {
    setStatus("Error: Friend name field is empty.", true);
    return;
  }
 
  try {
    // 1. Find the friend's profile (case-insensitive name match)
    const { data: found, error: findError } = await db
      .from("profiles")
      .select("id, name")
      .ilike("name", friendName)
      .limit(1);
 
    if (findError) throw findError;
 
    if (found.length === 0) {
      setStatus(
        `Error: No profile named "${friendName}" exists. Add that profile first.`,
        true
      );
      return;
    }
 
    const friendId = found[0].id;
 
    // 2. Self-friendship check (the DB also enforces this via CHECK constraint)
    if (friendId === currentProfileId) {
      setStatus("Error: A profile cannot be friends with itself.", true);
      return;
    }
 
    // 3. Normalize: put the smaller UUID in canonA (→ profile_id)
    //    This guarantees (A,B) and (B,A) map to the same DB row.
    const [canonA, canonB] =
      currentProfileId < friendId
        ? [currentProfileId, friendId]
        : [friendId, currentProfileId];
 
    // 4. Insert the single canonical row
    const { error: insertError } = await db
      .from("friends")
      .insert({ profile_id: canonA, friend_id: canonB });
 
    if (insertError) {
      if (insertError.code === "23505") {
        // 23505 = unique constraint violation: already friends
        setStatus(`"${found[0].name}" is already a friend.`, true);
      } else {
        throw insertError;
      }
      return;
    }
 
    document.getElementById("input-friend").value = "";
    // Re-render so both profiles will show each other going forward
    await selectProfile(currentProfileId);
    setStatus(`"${found[0].name}" added as a friend (bidirectional).`);
 
  } catch (err) {
    setStatus(`Error adding friend: ${err.message}`, true);
  }
}
 
 
async function removeFriend() {
  if (!currentProfileId) {
    setStatus("Error: No profile is selected.", true);
    return;
  }
  const friendName = document.getElementById("input-friend").value.trim();
  if (!friendName) {
    setStatus("Error: Friend name field is empty.", true);
    return;
  }
 
  try {
    // 1. Find the friend's profile
    const { data: found, error: findError } = await db
      .from("profiles")
      .select("id, name")
      .ilike("name", friendName)
      .limit(1);
 
    if (findError) throw findError;
 
    if (found.length === 0) {
      setStatus(`Error: No profile named "${friendName}" exists.`, true);
      return;
    }
 
    const friendId = found[0].id;
 
    // 2. Apply the SAME normalization used in addFriend.
    //    If we inserted (A, B) but try to delete (B, A), the
    //    query would match nothing and the friendship would
    //    silently persist. Same canonical order = correct target.
    const [canonA, canonB] =
      currentProfileId < friendId
        ? [currentProfileId, friendId]
        : [friendId, currentProfileId];
 
    // 3. Delete the canonical row
    const { error: deleteError } = await db
      .from("friends")
      .delete()
      .eq("profile_id", canonA)
      .eq("friend_id",  canonB);
 
    if (deleteError) throw deleteError;
 
    document.getElementById("input-friend").value = "";
    await selectProfile(currentProfileId);
    setStatus(`"${found[0].name}" removed from friends (both directions).`);
 
  } catch (err) {
    setStatus(`Error removing friend: ${err.message}`, true);
  }
}
 
 
// ================================================================
// Section 7: Event Listener Setup
// ================================================================
//
// DOMContentLoaded fires after the HTML is fully parsed but before
// images load. Every getElementById call is safe here because all
// elements already exist in the DOM at this point.
// ================================================================
 
document.addEventListener("DOMContentLoaded", async () => {
 
  // ── Left panel ───────────────────────────────────────────────
  document.getElementById("btn-add")
    .addEventListener("click", addProfile);
  document.getElementById("btn-lookup")
    .addEventListener("click", lookUpProfile);
  document.getElementById("btn-delete")
    .addEventListener("click", deleteProfile);
 
  // Enter key in the name field triggers Add
  document.getElementById("input-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addProfile();
  });
 
  // ── Right panel: status ──────────────────────────────────────
  document.getElementById("btn-status")
    .addEventListener("click", changeStatus);
  document.getElementById("input-status").addEventListener("keydown", (e) => {
    if (e.key === "Enter") changeStatus();
  });
 
  // ── Right panel: quote ───────────────────────────────────────
  document.getElementById("btn-quote")
    .addEventListener("click", changeQuote);
  document.getElementById("input-quote").addEventListener("keydown", (e) => {
    if (e.key === "Enter") changeQuote();
  });
 
  // ── Right panel: picture ─────────────────────────────────────
  document.getElementById("btn-picture")
    .addEventListener("click", changePicture);
 
  // Live preview: when the user picks a file, immediately show a
  // local object URL in the centre panel so they can verify it
  // looks right before clicking Update Picture. The preview uses
  // URL.createObjectURL() which creates a temporary in-memory URL
  // for the selected file — no upload happens at this stage.
  document.getElementById("input-picture-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
 
    // Revoke any previous object URL to free memory
    const pic = document.getElementById("profile-pic");
    if (pic.dataset.previewUrl) {
      URL.revokeObjectURL(pic.dataset.previewUrl);
    }
 
    const previewUrl = URL.createObjectURL(file);
    pic.src                = previewUrl;
    pic.dataset.previewUrl = previewUrl; // store so we can revoke it later
    setStatus("Preview loaded. Click 'Update Picture' to save to Vercel Blob.");
  });
 
  // ── Right panel: friends ─────────────────────────────────────
  document.getElementById("btn-add-friend")
    .addEventListener("click", addFriend);
  document.getElementById("btn-remove-friend")
    .addEventListener("click", removeFriend);
 
  // ── Exit button ──────────────────────────────────────────────
  // window.close() only works if this tab was opened by a script.
  // In most normal browser sessions it does nothing, so we
  // display an instruction message as a fallback.
  document.getElementById("btn-exit").addEventListener("click", () => {
    if (!window.close()) {
      setStatus("To exit, close this browser tab.");
    }
  });
 
  // ── Initial data load ────────────────────────────────────────
  await loadProfileList();
  setStatus("Ready. Select a profile from the list or add a new one.");
});