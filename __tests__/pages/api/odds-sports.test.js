jest.mock("../../../lib/sources/theOddsApi", () => ({
  fetchOddsSnapshot: jest.fn(),
}));

const { fetchOddsSnapshot } = require("../../../lib/sources/theOddsApi");
const { default: handler } = require("../../../pages/api/odds-sports");

function createMockRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonPayload = payload;
      return this;
    },
  };
}

beforeEach(() => {
  process.env.ODDS_API_KEY = "test-key";
  fetchOddsSnapshot.mockReset();
});

describe("API /api/odds-sports", () => {
  it("maps cached snapshots into bookmaker payloads", async () => {
    const kickoff = new Date("2024-05-14T18:00:00Z").toISOString();

    fetchOddsSnapshot.mockResolvedValueOnce({
      data: [
        {
          id: "evt-1",
          home_team: "Team Home",
          away_team: "Team Away",
          commence_time: kickoff,
          bookmakers: [
            {
              title: "TestBook",
              markets: [
                {
                  key: "h2h",
                  outcomes: [
                    { name: "Team Home", price: 1.9 },
                    { name: "Draw", price: 3.2 },
                    { name: "Team Away", price: 4.1 },
                  ],
                },
              ],
            },
          ],
        },
      ],
      fromCache: true,
      exhausted: false,
    });

    const req = {
      query: {
        home: "Team Home",
        away: "Team Away",
        ts: kickoff,
      },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchOddsSnapshot).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toEqual({
      bookmakers: [
        {
          name: "TestBook",
          bets: [
            {
              name: "1X2",
              values: [
                { value: "HOME", odd: 1.9 },
                { value: "DRAW", odd: 3.2 },
                { value: "AWAY", odd: 4.1 },
              ],
            },
          ],
        },
      ],
    });
  });

  it("returns an empty bookmaker list with a budget message when quota is exhausted", async () => {
    fetchOddsSnapshot.mockResolvedValue({
      data: null,
      exhausted: true,
    });

    const req = {
      query: {
        home: "Team Home",
        away: "Team Away",
        ts: "2024-05-14T18:00:00Z",
      },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(fetchOddsSnapshot).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toEqual({
      bookmakers: [],
      message: "Daily odds API budget exhausted",
    });
  });
});
