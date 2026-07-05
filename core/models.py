from typing import Optional
from pydantic import BaseModel


class PositionIn(BaseModel):
    account:       str
    stock_name:    str
    ticker:        str
    avg_buy_price: float
    quantity:      float
    buy_date:      Optional[str]   = None
    currency:      str             = "INR"
    pe:            Optional[float] = None
    market_cap:    Optional[float] = None
    sector:        Optional[str]   = None
    conviction:    Optional[float] = None
    notes:         Optional[str]   = ""
    active:        bool            = True


class WatchlistIn(BaseModel):
    stock_name:       str
    ticker:           str
    target_buy_price: Optional[float] = None
    added_price:      Optional[float] = None
    sector:           Optional[str]   = None
    notes:            Optional[str]   = ""
    source:           Optional[str]   = None


class MarketDashboardIn(BaseModel):
    title:        str
    created_date: str
    category:     Optional[str] = "my_resources"
    prompt:       Optional[str] = ""
    filename:     Optional[str] = None
    url:          Optional[str] = None
    notes:        Optional[str] = ""


class SettingsIn(BaseModel):
    usd_inr_rate:       Optional[float] = None
    portfolio_risk_pct: Optional[float] = None
    aif_invested:       Optional[float] = None
    target_cash_pct:    Optional[float] = None
    custom_sectors:     Optional[list]  = None


class HufTransferIn(BaseModel):
    date:         str
    from_account: str
    amount:       float
    notes:        Optional[str] = ""


class AifNavIn(BaseModel):
    month: str
    value: float


class AifInvestorMeetIn(BaseModel):
    id:           Optional[str] = None
    month:        str
    title:        Optional[str] = None
    youtube_url:  Optional[str] = None
    summary_url:  Optional[str] = None
    notes:        Optional[str] = None
    added_date:   Optional[str] = None


class MutualFundIn(BaseModel):
    fund_name:      str
    amc:            Optional[str]   = None
    scheme_code:    Optional[str]   = None
    holder:         str             = "vibhanshu"
    units:          Optional[float] = None
    nav:            Optional[float] = None
    nav_date:       Optional[str]   = None
    sip_amount:     Optional[float] = None
    sip_frequency:  Optional[str]   = "monthly"
    sip_start_date: Optional[str]   = None
    total_invested: Optional[float] = None
    notes:          Optional[str]   = ""


class FixedIncomeIn(BaseModel):
    name:          str
    type:          str             = "FD"
    holder:        str             = "vibhanshu"
    principal:     float
    rate:          Optional[float] = None
    start_date:    Optional[str]   = None
    maturity_date: Optional[str]   = None
    compounding:   Optional[str]   = "quarterly"
    current_value: Optional[float] = None
    notes:         Optional[str]   = ""


class UnlistedIn(BaseModel):
    company_name:      str
    sector:            Optional[str]   = None
    holder:            str             = "vibhanshu"
    invested_amount:   float
    current_valuation: Optional[float] = None
    investment_date:   Optional[str]   = None
    stage:             Optional[str]   = None
    notes:             Optional[str]   = ""


class NpsIn(BaseModel):
    holder:         str            = "vibhanshu"
    pran:           Optional[str]  = None
    tier:           str            = "Tier I"
    fund_manager:   Optional[str]  = None
    scheme:         Optional[str]  = None
    total_invested: Optional[float] = None
    current_value:  Optional[float] = None
    as_of_date:     Optional[str]  = None
    notes:          Optional[str]  = ""
