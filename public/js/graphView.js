/**
 * Knowledge graph rendering.
 *
 * Plain SVG with a deterministic concentric layout. No charting library: the
 * page has no build step, and a dependency would have to be fetched at runtime
 * for a view this simple.
 *
 * A force simulation was tried first, but on a real profile (hundreds of
 * papers, topics and institutions) it collapsed into one unreadable blob. Rings
 * keep every node type in its own band, so the picture stays legible at any
 * size and the same graph always draws the same way.
 */
const GraphView = (() => {
  const NODE_STYLE = {
    Researcher: { color: '#3b5bfd', radius: 16 },
    Paper: { color: '#7c5cff', radius: 7 },
    Topic: { color: '#0f9d76', radius: 9 },
    Domain: { color: '#b26a00', radius: 11 },
    Institution: { color: '#c2410c', radius: 9 },
    Method: { color: '#0369a1', radius: 9 },
    Dataset: { color: '#9333ea', radius: 9 },
    // Candidate gaps are the one node type that is a proposal rather than a
    // record, so they are drawn larger and in a warning colour.
    ResearchGap: { color: '#b45309', radius: 13 }
  };

  const DEFAULT_STYLE = { color: '#6b7488', radius: 7 };

  function styleFor(type) {
    return NODE_STYLE[type] || DEFAULT_STYLE;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Concentric layout.
   *
   *   centre  Researcher
   *   ring 1  Papers, grouped by domain and topic
   *   ring 2  Topics, methods, datasets, domains
   *   ring 3  Institutions and candidate research gaps
   *
   * An attribute is placed at the average angle of the papers it is attached
   * to, so a topic shared by two papers sits between them and its edges stay
   * short. A ring with more nodes than fit around it is split into parallel
   * tracks inside its band, so a large profile spreads out instead of piling
   * nodes on top of each other.
   */
  function radialLayout(nodes, edges, width, height) {
    const centreX = width / 2;
    const centreY = height / 2;

    const RING_ORDER = {
      Paper: 1,
      Topic: 2, Method: 2, Dataset: 2, Domain: 2,
      Institution: 3, ResearchGap: 3
    };

    // Each ring owns a band of radii; its tracks are spread across the band.
    const RING_BAND = { 1: [0.24, 0.44], 2: [0.56, 0.82], 3: [0.92, 1] };

    // Rings are elliptical rather than circular. A laptop or projector canvas
    // is much wider than it is tall, and a circle sized to the short side
    // wastes the horizontal space where the labels need to go.
    const marginX = Math.min(190, width * 0.19);
    const marginY = 44;
    const radiusX = Math.max(110, width / 2 - marginX);
    const radiusY = Math.max(80, height / 2 - marginY);

    const place = (node, angle, factor) => {
      node.x = centreX + Math.cos(angle) * radiusX * factor;
      node.y = centreY + Math.sin(angle) * radiusY * factor;
    };

    /**
     * How many tracks a ring needs: enough that neighbours on one track do not
     * touch. Even a ring that fits gets two once it is busy, so neighbouring
     * labels sit at different distances from the centre.
     */
    function trackCount(ring, members) {
      const [low, high] = RING_BAND[ring];
      const factor = (low + high) / 2;
      const a = radiusX * factor;
      const b = radiusY * factor;
      const perimeter = Math.PI * 2 * Math.sqrt((a * a + b * b) / 2);
      const widest = Math.max(...members.map((node) => styleFor(node.type).radius));
      const capacity = Math.max(1, Math.floor(perimeter / (widest * 2 + 8)));
      const needed = Math.ceil(members.length / capacity);
      return Math.min(4, Math.max(needed, members.length > 8 ? 2 : 1));
    }

    /** Radius factor of track `track` out of `tracks` on a ring. */
    function trackFactor(ring, track, tracks) {
      const [low, high] = RING_BAND[ring];
      const mid = (low + high) / 2;
      if (tracks < 2) return ring === 3 ? high : mid;
      // Two tracks only need a slight offset; four use the whole band.
      const half = ((high - low) / 2) * Math.min(1, (tracks - 1) / 3);
      return mid - half + (2 * half * track) / (tracks - 1);
    }

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const neighbours = new Map();
    edges.forEach((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return;
      (neighbours.get(from.id) || neighbours.set(from.id, []).get(from.id)).push(to);
      (neighbours.get(to.id) || neighbours.set(to.id, []).get(to.id)).push(from);
    });

    const researcher = nodes.find((node) => node.type === 'Researcher');
    if (researcher) {
      researcher.x = centreX;
      researcher.y = centreY;
    }

    // Ring 1: papers, spread evenly around the researcher. Papers sharing a
    // domain and topic sit next to each other, so the edges out to ring 2 fan
    // out in tidy bundles instead of criss-crossing the picture.
    const groupKey = (node) => {
      const linked = neighbours.get(node.id) || [];
      const first = (type) => (linked.find((other) => other.type === type) || {}).label || '￿';
      return `${first('Domain')}\u0000${first('Topic')}`;
    };

    const papers = nodes
      .filter((node) => RING_ORDER[node.type] === 1)
      .map((node, index) => ({ node, index, key: groupKey(node) }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index)
      .map((entry) => entry.node);

    const paperAngle = new Map();
    const paperTracks = papers.length ? trackCount(1, papers) : 1;

    papers.forEach((node, index) => {
      // Start at -90deg so the first paper sits at the top rather than the right.
      const angle = -Math.PI / 2 + (index / Math.max(papers.length, 1)) * Math.PI * 2;
      paperAngle.set(node.id, angle);
      place(node, angle, trackFactor(1, index % paperTracks, paperTracks));
    });

    /** Mean of angles, taken on the unit circle so 350deg and 10deg average to 0. */
    function meanAngle(angles) {
      if (!angles.length) return null;
      let sumX = 0;
      let sumY = 0;
      angles.forEach((angle) => {
        sumX += Math.cos(angle);
        sumY += Math.sin(angle);
      });
      if (Math.abs(sumX) < 1e-9 && Math.abs(sumY) < 1e-9) return null;
      return Math.atan2(sumY, sumX);
    }

    // Which papers each outer node is connected to.
    const connectedPapers = new Map();
    edges.forEach((edge) => {
      [[edge.from, edge.to], [edge.to, edge.from]].forEach(([a, b]) => {
        if (!paperAngle.has(b)) return;
        const list = connectedPapers.get(a) || [];
        list.push(paperAngle.get(b));
        connectedPapers.set(a, list);
      });
    });

    /** Normalises to [-PI, PI) so sorting and gap maths behave near the wrap. */
    function wrap(angle) {
      let value = angle;
      while (value < -Math.PI) value += Math.PI * 2;
      while (value >= Math.PI) value -= Math.PI * 2;
      return value;
    }

    [2, 3].forEach((ring) => {
      const members = nodes.filter((node) => RING_ORDER[node.type] === ring);
      if (!members.length) return;

      const withAngle = members.map((node, index) => ({
        node,
        index,
        preferred: meanAngle(connectedPapers.get(node.id) || [])
      }));

      const anchored = withAngle
        .filter((entry) => entry.preferred != null)
        .map((entry) => ({ ...entry, preferred: wrap(entry.preferred) }))
        .sort((a, b) => a.preferred - b.preferred || a.index - b.index);

      const floating = withAngle.filter((entry) => entry.preferred == null);

      // Every node on the ring gets at least this much angular room. The full
      // circle is shared out, so a crowded ring simply spaces more tightly
      // rather than stacking nodes on top of each other.
      const step = (Math.PI * 2) / Math.max(members.length, 1);
      const minGap = step * 0.82;

      // Push each anchored node forward until it clears its predecessor, then
      // check the wrap-around pair so the last node cannot land on the first.
      let previous = null;
      anchored.forEach((entry) => {
        let angle = entry.preferred;
        if (previous != null && angle - previous < minGap) angle = previous + minGap;
        previous = angle;
        entry.angle = angle;
      });

      if (anchored.length > 1) {
        const first = anchored[0].angle;
        const last = anchored[anchored.length - 1].angle;
        const wrapGap = first + Math.PI * 2 - last;

        if (wrapGap < minGap) {
          // Spread the whole ring evenly instead: the anchoring cannot be
          // honoured without collisions, and legibility matters more.
          anchored.forEach((entry, index) => {
            entry.angle = first + index * ((Math.PI * 2) / anchored.length);
          });
        }
      }

      // Floating nodes are dropped into the widest remaining arcs.
      const taken = anchored.map((entry) => wrap(entry.angle)).sort((a, b) => a - b);
      floating.forEach((entry, index) => {
        if (!taken.length) {
          entry.angle = -Math.PI / 2 + index * step;
          return;
        }
        let widest = 0;
        let widestAt = taken[0] + step;
        for (let i = 0; i < taken.length; i += 1) {
          const from = taken[i];
          const to = i === taken.length - 1 ? taken[0] + Math.PI * 2 : taken[i + 1];
          if (to - from > widest) {
            widest = to - from;
            widestAt = from + (to - from) / 2;
          }
        }
        entry.angle = widestAt;
        taken.push(wrap(widestAt));
        taken.sort((a, b) => a - b);
      });

      // Neighbours alternate between tracks, so two adjacent nodes sit at
      // different distances from the centre and their labels separate.
      const tracks = trackCount(ring, members);

      [...anchored, ...floating]
        .sort((a, b) => wrap(a.angle) - wrap(b.angle))
        .forEach((entry, index) => {
          place(entry.node, entry.angle, trackFactor(ring, index % tracks, tracks));
        });
    });

    // Anything unplaced (an unexpected type) goes on the outer ring.
    nodes.forEach((node, index) => {
      if (node.x != null && node.y != null) return;
      place(node, -Math.PI / 2 + index * 2.399963, RING_BAND[3][1]);
    });

    // Keep every node inside the canvas.
    nodes.forEach((node) => {
      const radius = styleFor(node.type).radius + 10;
      node.x = Math.max(radius, Math.min(width - radius, node.x));
      node.y = Math.max(radius, Math.min(height - radius, node.y));
    });
  }

  function truncate(text, limit) {
    const value = String(text || '');
    // The full name is always available from the node's <title> on hover and
    // from the detail panel on click, so trimming here loses nothing.
    return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}...` : value;
  }

  /** Label metrics. Approximate, but enough to keep labels off each other. */
  const LABEL_FONT_SIZE = 11.5;
  const LABEL_CHAR_WIDTH = LABEL_FONT_SIZE * 0.53;
  const LABEL_LINE_HEIGHT = LABEL_FONT_SIZE * 1.25;

  /**
   * Places a label around its node, pushed outward from the centre.
   *
   * A radial layout reads far better when labels radiate outward rather than
   * all sitting above their node: nodes on the right get left-aligned text to
   * their right, nodes on the left get right-aligned text to their left, and
   * only nodes near the top or bottom keep a centred label.
   */
  function labelPlacement(node, radius, centreX, centreY) {
    const dx = node.x - centreX;
    const dy = node.y - centreY;
    const distance = Math.hypot(dx, dy) || 1;
    const cos = dx / distance;

    const gap = radius + 7;

    if (cos > 0.32) {
      return { x: node.x + gap, y: node.y + LABEL_FONT_SIZE * 0.35, anchor: 'start' };
    }
    if (cos < -0.32) {
      return { x: node.x - gap, y: node.y + LABEL_FONT_SIZE * 0.35, anchor: 'end' };
    }
    // Near the vertical axis: above for the top half, below for the bottom.
    return dy < 0
      ? { x: node.x, y: node.y - radius - 8, anchor: 'middle' }
      : { x: node.x, y: node.y + radius + LABEL_FONT_SIZE + 3, anchor: 'middle' };
  }

  /** The box a label would occupy, used for collision checks. */
  function labelBox(placement, text) {
    const width = text.length * LABEL_CHAR_WIDTH;
    const left =
      placement.anchor === 'start' ? placement.x
        : placement.anchor === 'end' ? placement.x - width
          : placement.x - width / 2;

    return {
      left: left - 2,
      right: left + width + 2,
      top: placement.y - LABEL_LINE_HEIGHT * 0.8,
      bottom: placement.y + LABEL_LINE_HEIGHT * 0.3
    };
  }

  function overlaps(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  /**
   * Draws one node. Candidate research gaps are diamonds rather than circles,
   * so they are distinguishable by shape as well as colour - which survives a
   * projector, a greyscale printout and colour blindness.
   */
  function nodeShape(node, radius, style) {
    const x = node.x;
    const y = node.y;
    const fillOpacity = node.provenance === 'llm' ? 0.62 : 0.92;

    if (node.type === 'ResearchGap') {
      const r = radius * 1.18;
      const points = [
        `${x.toFixed(1)},${(y - r).toFixed(1)}`,
        `${(x + r).toFixed(1)},${y.toFixed(1)}`,
        `${x.toFixed(1)},${(y + r).toFixed(1)}`,
        `${(x - r).toFixed(1)},${y.toFixed(1)}`
      ].join(' ');

      return (
        `<circle class="graph-gap-halo" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" ` +
        `r="${(r + 6).toFixed(1)}" fill="none" stroke="${style.color}" stroke-width="1.4" ` +
        `stroke-dasharray="3 3" stroke-opacity="0.75" />` +
        `<polygon class="graph-gap" points="${points}" fill="${style.color}" ` +
        `fill-opacity="0.92" stroke="${style.color}" stroke-width="2.5" stroke-linejoin="round" />`
      );
    }

    return (
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(1)}" ` +
      `fill="${style.color}" fill-opacity="${fillOpacity}" stroke="${style.color}" ` +
      `stroke-width="${node.provenance === 'llm' ? 2 : 1}" ` +
      `stroke-dasharray="${node.provenance === 'llm' ? '3 2' : 'none'}" />`
    );
  }

  /**
   * Canvas size.
   *
   * The radial graph is laid out on an ellipse, so it wants a wide box: on a
   * laptop or a projector that fills the slide instead of leaving bands of
   * empty space down each side. Height is derived from width and clamped so
   * the graph never grows taller than a screen.
   */
  function canvasSize(container, graph) {
    const width = Math.max(container.clientWidth || 900, 320);
    const count = graph.nodes.length;
    // A large profile gets a taller canvas so its outer rings have room.
    const ideal = width * (width < 620 ? 0.92 : count > 80 ? 0.64 : 0.54);
    const room = Math.max(360, Math.min(count * 26 + 220, 820));
    return { width, height: Math.round(Math.max(420, Math.min(ideal, room))) };
  }

  /** Renders the SVG. Deterministic: the same graph at the same size agrees. */
  function draw(container, graph, { onSelect } = {}) {
    const { width, height } = canvasSize(container, graph);
    const centreX = width / 2;
    const centreY = height / 2;

    // Work on copies so a re-render never inherits stale coordinates.
    const nodes = graph.nodes.map((node) => ({ ...node, x: null, y: null }));
    const edges = graph.edges.map((edge) => ({ ...edge }));

    radialLayout(nodes, edges, width, height);

    const byId = new Map(nodes.map((node) => [node.id, node]));

    const edgeMarkup = edges
      .map((edge) => {
        const source = byId.get(edge.from);
        const target = byId.get(edge.to);
        if (!source || !target) return '';
        const isSupport = edge.type === 'SUPPORTS';
        return `<line class="graph-edge${edge.provenance === 'llm' ? ' graph-edge-llm' : ''}${
          isSupport ? ' graph-edge-support' : ''
        }"
          x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}"
          x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}"
          data-edge="${escapeHtml(edge.id)}"><title>${escapeHtml(edge.type)}</title></line>`;
      })
      .join('');

    const radiusOf = (node) =>
      styleFor(node.type).radius + Math.min(6, Math.log2(node.weight + 1) * 2);

    /**
     * Label priority. The researcher anchors the picture and a candidate gap
     * is what a reader is looking for, so those two come first; the rest
     * compete on how often they appear.
     */
    const priority = (node) => {
      if (node.type === 'Researcher') return 1000;
      if (node.type === 'ResearchGap') return 900;
      if (node.type === 'Paper') return 10 + node.weight;
      return 100 + node.weight;
    };

    // Place labels highest priority first, skipping any that would collide
    // with a node or a label already placed. A skipped label is not lost: the
    // full name is on the node tooltip and in the detail panel when clicked.
    const placedBoxes = nodes.map((node) => {
      const radius = radiusOf(node);
      return {
        left: node.x - radius,
        right: node.x + radius,
        top: node.y - radius,
        bottom: node.y + radius
      };
    });
    const labels = new Map();

    [...nodes]
      .sort((a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id))
      .forEach((node) => {
        const radius = radiusOf(node);
        const limit = node.type === 'Paper' ? 24 : 26;
        const text = truncate(node.label, limit);
        const placement = labelPlacement(node, radius, centreX, centreY);
        const box = labelBox(placement, text);

        // A label spilling off the canvas helps nobody.
        if (box.left < 2 || box.right > width - 2 || box.top < 2 || box.bottom > height - 2) return;
        if (placedBoxes.some((existing) => overlaps(existing, box))) return;

        placedBoxes.push(box);
        labels.set(node.id, { text, placement });
      });

    const nodeMarkup = nodes
      .map((node) => {
        const style = styleFor(node.type);
        const radius = radiusOf(node);
        const entry = labels.get(node.id);

        const label = entry
          ? `<text class="graph-label${node.type === 'ResearchGap' ? ' graph-label-gap' : ''}" ` +
            `x="${entry.placement.x.toFixed(1)}" y="${entry.placement.y.toFixed(1)}" ` +
            `text-anchor="${entry.placement.anchor}">${escapeHtml(entry.text)}</text>`
          : '';

        return `
          <g class="graph-node graph-node-${escapeHtml(node.type)}" data-node="${escapeHtml(node.id)}"
             tabindex="0" role="button"
             aria-label="${escapeHtml(node.type)}: ${escapeHtml(node.label)}">
            ${nodeShape(node, radius, style)}
            <title>${escapeHtml(node.type)}: ${escapeHtml(node.label)}</title>
            ${label}
          </g>`;
      })
      .join('');

    container.innerHTML = `
      <svg class="graph-svg${edges.length > 120 ? ' graph-svg-dense' : ''}" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
           preserveAspectRatio="xMidYMid meet"
           role="img" aria-label="Knowledge graph of the researcher, their publications, topics, domains and candidate research gaps">
        <g class="graph-edges">${edgeMarkup}</g>
        <g class="graph-nodes">${nodeMarkup}</g>
      </svg>`;

    if (onSelect) {
      const select = (event) => {
        const group = event.target.closest('[data-node]');
        if (!group) return;
        container.querySelectorAll('.graph-node.selected').forEach((el) => el.classList.remove('selected'));
        group.classList.add('selected');

        const node = byId.get(group.dataset.node);
        const connected = edges
          .filter((edge) => edge.from === node.id || edge.to === node.id)
          .map((edge) => ({
            type: edge.type,
            other: byId.get(edge.from === node.id ? edge.to : edge.from)
          }))
          .filter((entry) => entry.other);

        onSelect(node, connected);
      };

      container.addEventListener('click', select);
      container.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(event);
        }
      });
    }

    return { width, height, rendered: nodes.length, labelled: labels.size };
  }

  /**
   * Redraws when the container changes width, so the graph fits a resized
   * window or a projector without needing a reload. The redraw is the same
   * deterministic layout at a new size, not an animation.
   */
  function watchResize(container, graph, options) {
    if (typeof ResizeObserver === 'undefined') return;

    // A previous observer would keep firing against a stale graph.
    if (container.graphResizeObserver) container.graphResizeObserver.disconnect();

    let lastWidth = container.clientWidth;
    let pending = null;

    const observer = new ResizeObserver(() => {
      const width = container.clientWidth;
      // Ignore the reflow the redraw itself causes, and sub-pixel jitter.
      if (!width || Math.abs(width - lastWidth) < 40) return;
      lastWidth = width;

      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        draw(container, graph, options);
      }, 120);
    });

    observer.observe(container);
    container.graphResizeObserver = observer;
  }

  /**
   * Draws the graph into `container`.
   *
   * @param {HTMLElement} container
   * @param {{nodes: Array, edges: Array}} graph
   * @param {{onSelect?: function}} options
   */
  function render(container, graph, options = {}) {
    const result = draw(container, graph, options);
    watchResize(container, graph, options);
    return result;
  }

  /** Legend entries for the node types actually present in this graph. */
  function renderLegend(container, graph) {
    const present = [...new Set(graph.nodes.map((node) => node.type))];
    const counts = (graph.summary && graph.summary.nodes_by_type) ||
      (graph.meta && graph.meta.nodes_by_type) || {};

    const swatches = present
      .map((type) => {
        const style = styleFor(type);
        const count = counts[type] || 0;
        return `
          <span class="legend-item">
            <span class="legend-dot" style="background:${style.color}"></span>
            ${escapeHtml(type)} <span class="legend-count">${count}</span>
          </span>`;
      })
      .join('');

    const llmNote = (graph.summary && graph.summary.llm_derived_nodes)
      ? '<span class="legend-item"><span class="legend-dot legend-dot-llm"></span>Dashed outline = model-extracted</span>'
      : '';

    container.innerHTML = `${swatches}${llmNote}`;
  }

  return { render, draw, renderLegend, radialLayout, labelPlacement, labelBox, overlaps, styleFor, NODE_STYLE };
})();
